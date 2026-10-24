import { asc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context";
import {
  computeJobs,
  contracts,
  experiments,
  gpuInstances,
  invoiceLines,
  lifecycleEvents,
  providerUsage,
  reservations,
  type CheckFlag,
  type InstanceChecks,
  type ReconciliationChecks,
  type ReservationChecks,
} from "../db/schema";
import { contractBillableHours, expectedChargeCents, hoursBetween, unionHours } from "../domain/billing";
import { formatCents, round2 } from "../domain/money";
import { ControlError } from "../security/errors";

export type InvoiceLineRow = typeof invoiceLines.$inferSelect;

/** Flags that open a work item for agent investigation. */
const EXCEPTION_FLAGS = new Set([
  "AMOUNT_VARIANCE",
  "QUANTITY_EXCEEDS_LIFECYCLE",
  "RATE_MISMATCH",
  "IDLE_TIME",
  "NO_TERMINATION_RECORD",
  "SHARED_RESOURCE",
  "MISSING_OWNER",
  "DUPLICATE_CHARGE",
]);

export function needsInvestigation(checks: ReconciliationChecks) {
  return checks.flags.some((f) => EXCEPTION_FLAGS.has(f.code));
}

export function contractForProvider(ctx: AppContext, providerId: string) {
  const contract = ctx.db.select().from(contracts).where(eq(contracts.providerId, providerId)).get();
  if (!contract) throw new ControlError("No contract on file for provider " + providerId, "NO_CONTRACT", "FAILED");
  return contract;
}

export function instanceLifecycle(ctx: AppContext, instanceId: string, fallbackEnd: string) {
  const events = ctx.db
    .select()
    .from(lifecycleEvents)
    .where(eq(lifecycleEvents.instanceId, instanceId))
    .orderBy(asc(lifecycleEvents.occurredAt))
    .all();
  const provisionedAt = events.find((e) => e.eventType === "PROVISIONED")?.occurredAt ?? null;
  const terminatedAt = events.find((e) => e.eventType === "TERMINATED")?.occurredAt ?? null;
  const lifecycleHours = provisionedAt ? hoursBetween(provisionedAt, terminatedAt ?? fallbackEnd) : 0;
  return { events, provisionedAt, terminatedAt, lifecycleHours: round2(lifecycleHours) };
}

export function reservationUsage(ctx: AppContext, reservationId: string) {
  const reservation = ctx.db.select().from(reservations).where(eq(reservations.id, reservationId)).get();
  if (!reservation) throw new ControlError("Unknown reservation " + reservationId, "NOT_FOUND", "FAILED");
  const jobs = ctx.db.select().from(computeJobs).where(eq(computeJobs.reservationId, reservationId)).all();
  const expIds = [...new Set(jobs.map((j) => j.experimentId))];
  const exps = expIds.length ? ctx.db.select().from(experiments).where(inArray(experiments.id, expIds)).all() : [];
  const byProject = new Map<string, number>();
  for (const job of jobs) {
    const exp = exps.find((e) => e.id === job.experimentId);
    const projectId = exp?.projectId ?? "UNATTRIBUTED";
    const gpuHours = round2(hoursBetween(job.startedAt, job.endedAt) * job.gpus);
    byProject.set(projectId, round2((byProject.get(projectId) ?? 0) + gpuHours));
  }
  const reservedGpuHours = round2(reservation.gpuCount * reservation.hours);
  const usedGpuHours = round2([...byProject.values()].reduce((s, h) => s + h, 0));
  return {
    reservation,
    jobs,
    experiments: exps,
    usageByProject: [...byProject.entries()]
      .map(([projectId, gpuHours]) => ({ projectId, gpuHours }))
      .sort((a, b) => b.gpuHours - a.gpuHours),
    reservedGpuHours,
    usedGpuHours,
    idleGpuHours: round2(Math.max(0, reservedGpuHours - usedGpuHours)),
  };
}

function analyzeInstanceLine(ctx: AppContext, line: InvoiceLineRow): InstanceChecks {
  const instance = ctx.db.select().from(gpuInstances).where(eq(gpuInstances.id, line.instanceId ?? "")).get();
  if (!instance) throw new ControlError("Invoice line references unknown instance " + line.instanceId, "NOT_FOUND", "FAILED");
  const contract = contractForProvider(ctx, instance.providerId);
  const life = instanceLifecycle(ctx, instance.id, line.serviceEnd);
  const billableHours = contractBillableHours(life.lifecycleHours, contract);
  const contractRateCents = contract.rateCard[instance.instanceType] ?? 0;
  // Hours already billed for this instance on earlier lines are not billable again.
  const prior = ctx.sqlite
    .prepare(
      "SELECT id, quantity FROM invoice_lines WHERE instance_id = ? AND rowid < (SELECT rowid FROM invoice_lines WHERE id = ?) ORDER BY rowid",
    )
    .all(instance.id, line.id) as { id: string; quantity: number }[];
  const priorBilledHours = round2(prior.reduce((s, p) => s + p.quantity, 0));
  const remainingHours = round2(Math.max(0, billableHours - priorBilledHours));
  const expectedCents = expectedChargeCents(remainingHours, contractRateCents);
  const jobs = ctx.db.select().from(computeJobs).where(eq(computeJobs.instanceId, instance.id)).all();
  const schedulerHours = round2(unionHours(jobs.map((j) => ({ start: j.startedAt, end: j.endedAt }))));
  const usage = ctx.db.select().from(providerUsage).where(eq(providerUsage.instanceId, instance.id)).all();
  const providerMeterHours = round2(usage.reduce((s, u) => s + u.hours, 0));
  const expIds = [...new Set(jobs.map((j) => j.experimentId))];
  const exps = expIds.length ? ctx.db.select().from(experiments).where(inArray(experiments.id, expIds)).all() : [];
  const ownerProjectIds = [...new Set(exps.map((e) => e.projectId).filter((p): p is string => Boolean(p)))];
  const discrepancyCents = line.amountCents - expectedCents;
  const flags: CheckFlag[] = [];

  if (Math.abs(discrepancyCents) >= 100) {
    flags.push({
      code: "AMOUNT_VARIANCE",
      severity: Math.abs(discrepancyCents) >= 100_000 ? "high" : "medium",
      message: "Invoiced " + formatCents(line.amountCents) + " vs contract-supported " + formatCents(expectedCents) + ".",
    });
  }
  if (prior.length) {
    flags.push({
      code: "DUPLICATE_CHARGE",
      severity: "high",
      message:
        "Earlier line " + prior.map((p) => p.id).join(", ") + " already billed " + priorBilledHours + " h for " + instance.id +
        "; " + remainingHours + " billable h remain.",
    });
  }
  if (line.quantity > remainingHours + 1e-6) {
    flags.push({
      code: "QUANTITY_EXCEEDS_LIFECYCLE",
      severity: "high",
      message:
        "Billed " + line.quantity + " h but the instance lifecycle supports " + billableHours + " billable h" +
        (prior.length ? " (" + remainingHours + " h not yet billed)." : "."),
    });
  }
  if (line.unitPriceCents !== contractRateCents) {
    flags.push({
      code: "RATE_MISMATCH",
      severity: "high",
      message: "Billed rate " + formatCents(line.unitPriceCents) + "/h vs contract " + formatCents(contractRateCents) + "/h.",
    });
  }
  if (line.quantity - schedulerHours > Math.max(1, line.quantity * 0.05)) {
    flags.push({
      code: "IDLE_TIME",
      severity: "low",
      message:
        "Invoice exceeds scheduler-recorded runtime by " + round2(line.quantity - schedulerHours) + " h (" +
        schedulerHours + " h of jobs).",
    });
  }
  if (Math.abs(providerMeterHours - life.lifecycleHours) > 0.5) {
    flags.push({
      code: "METER_MISMATCH",
      severity: "medium",
      message: "Provider meter recorded " + providerMeterHours + " h; lifecycle shows " + life.lifecycleHours + " h.",
    });
  }
  if (!life.terminatedAt) {
    flags.push({ code: "NO_TERMINATION_RECORD", severity: "medium", message: "No TERMINATED event for " + instance.id + "." });
  }
  if (ownerProjectIds.length === 0) {
    flags.push({ code: "MISSING_OWNER", severity: "medium", message: "No experiment on this instance has an owning project." });
  }

  return {
    kind: "instance",
    instanceId: instance.id,
    instanceType: instance.instanceType,
    contractId: contract.id,
    contractRateCents,
    invoicedRateCents: line.unitPriceCents,
    provisionedAt: life.provisionedAt,
    terminatedAt: life.terminatedAt,
    lifecycleHours: life.lifecycleHours,
    billableHours,
    billedHours: line.quantity,
    schedulerHours,
    idleHours: round2(Math.max(0, life.lifecycleHours - schedulerHours)),
    providerMeterHours,
    expectedCents,
    invoicedCents: line.amountCents,
    discrepancyCents,
    ownerProjectIds,
    experimentIds: expIds,
    jobIds: jobs.map((j) => j.id),
    flags,
    ...(prior.length ? { priorLineIds: prior.map((p) => p.id), priorBilledHours } : {}),
  };
}

function analyzeReservationLine(ctx: AppContext, line: InvoiceLineRow): ReservationChecks {
  const usage = reservationUsage(ctx, line.reservationId ?? "");
  const contract = contractForProvider(ctx, usage.reservation.providerId);
  const expectedCents = usage.reservation.committedCents;
  const discrepancyCents = line.amountCents - expectedCents;
  const flags: CheckFlag[] = [];
  if (Math.abs(discrepancyCents) >= 100) {
    flags.push({
      code: "AMOUNT_VARIANCE",
      severity: "high",
      message: "Invoiced " + formatCents(line.amountCents) + " vs committed " + formatCents(expectedCents) + ".",
    });
  }
  const projectsUsing = usage.usageByProject.filter((u) => u.gpuHours > 0);
  if (projectsUsing.length > 1) {
    flags.push({
      code: "SHARED_RESOURCE",
      severity: line.amountCents >= 1_000_000 ? "high" : "medium",
      message:
        projectsUsing.length + " projects used reservation " + usage.reservation.id + "; " + usage.idleGpuHours +
        " reserved GPU-h were idle.",
    });
  }
  return {
    kind: "reservation",
    reservationId: usage.reservation.id,
    ownerProjectId: usage.reservation.ownerProjectId,
    contractId: contract.id,
    expectedCents,
    invoicedCents: line.amountCents,
    discrepancyCents,
    reservedGpuHours: usage.reservedGpuHours,
    usedGpuHours: usage.usedGpuHours,
    idleGpuHours: usage.idleGpuHours,
    usageByProject: usage.usageByProject,
    experimentIds: usage.experiments.map((e) => e.id),
    jobIds: usage.jobs.map((j) => j.id),
    flags,
  };
}

/** Deterministic comparison of an invoice line against expected compute charges. */
export function analyzeInvoiceLine(ctx: AppContext, line: InvoiceLineRow): ReconciliationChecks {
  return line.lineType === "reservation" ? analyzeReservationLine(ctx, line) : analyzeInstanceLine(ctx, line);
}
