import { desc } from "drizzle-orm";
import { appendAudit } from "../audit";
import { nextId, tx, type AppContext } from "../context";
import {
  computeJobs,
  experiments,
  gpuInstances,
  ingestionEvents,
  lifecycleEvents,
  providerUsage,
  reservations,
  type JobLogEntry,
} from "../db/schema";
import { ACTOR } from "../security/actors";
import { authorize } from "../security/authorize";
import { ControlError } from "../security/errors";
import { ingestBillingEvent, type BillingEvent, type IngestionResult } from "../workflow/ingestion";

/*
 * Simulated source systems. These builders write records as the
 * infrastructure controller, GPU scheduler, experiment tracker, and provider
 * meter would, then hand the provider's invoice line to the normal ingestion
 * pipeline. Nothing here decides an outcome; agents and checks do.
 */

export interface ScenarioData {
  experiments: (typeof experiments.$inferInsert)[];
  reservations: (typeof reservations.$inferInsert)[];
  instances: (typeof gpuInstances.$inferInsert)[];
  lifecycle: (typeof lifecycleEvents.$inferInsert)[];
  jobs: (typeof computeJobs.$inferInsert)[];
  usage: (typeof providerUsage.$inferInsert)[];
  event: BillingEvent;
}

function addHours(iso: string, hours: number) {
  return new Date(Date.parse(iso) + hours * 3_600_000).toISOString();
}

function money(cents: number) {
  return "$" + (cents / 100).toFixed(2);
}

function jobLogs(start: string, end: string, gpus: number, label: string): JobLogEntry[] {
  const mid = addHours(start, (Date.parse(end) - Date.parse(start)) / 7_200_000);
  return [
    { ts: start, level: "info", message: "Job started on " + gpus + " GPUs (" + label + ")" },
    { ts: mid, level: "info", message: "Checkpoint saved" },
    { ts: end, level: "info", message: "Training complete; final checkpoint uploaded; job exited 0" },
  ];
}

export interface InstanceCaseInput {
  key: string;
  providerId: string;
  instanceId: string;
  instanceType: string;
  projectId: string | null;
  experimentId: string;
  experimentName: string;
  owner: string;
  provisionedAt: string;
  lifecycleHours: number;
  jobHours: number;
  billedHours: number;
  meterHours?: number;
  rateCents: number;
  invoice: { id: string; number: string; lineId: string };
  jobId: string;
  terminationRef?: string;
}

export function buildInstanceCase(input: InstanceCaseInput): ScenarioData {
  const provisioned = input.provisionedAt;
  const terminated = addHours(provisioned, input.lifecycleHours);
  const jobStart = addHours(provisioned, Math.min(0.33, input.lifecycleHours / 10));
  const jobEnd = addHours(jobStart, Math.min(input.jobHours, input.lifecycleHours - 0.34));
  const meterHours = input.meterHours ?? input.lifecycleHours;
  const period = provisioned.slice(0, 7);
  const amountCents = Math.round(input.billedHours * input.rateCents);
  return {
    experiments: [
      {
        id: input.experimentId,
        projectId: input.projectId,
        name: input.experimentName,
        owner: input.owner,
        description: input.experimentName + " (tracked in Weights & Biases)",
        tracker: "wandb",
      },
    ],
    reservations: [],
    instances: [{ id: input.instanceId, providerId: input.providerId, instanceType: input.instanceType, gpuCount: 8, region: "us-west-2" }],
    lifecycle: [
      { instanceId: input.instanceId, eventType: "REQUESTED", occurredAt: addHours(provisioned, -0.03), source: "kubernetes", reference: null },
      { instanceId: input.instanceId, eventType: "PROVISIONED", occurredAt: provisioned, source: "kubernetes", reference: null },
      { instanceId: input.instanceId, eventType: "STOP_REQUESTED", occurredAt: addHours(terminated, -0.07), source: "kubernetes", reference: null },
      {
        instanceId: input.instanceId,
        eventType: "TERMINATED",
        occurredAt: terminated,
        source: "provider-api-ack",
        reference: input.terminationRef ?? "api-ack-" + input.instanceId.split("-").pop(),
      },
    ],
    jobs: [
      {
        id: input.jobId,
        experimentId: input.experimentId,
        instanceId: input.instanceId,
        reservationId: null,
        submittedBy: input.owner,
        gpus: 8,
        startedAt: jobStart,
        endedAt: jobEnd,
        status: "COMPLETED",
        logs: jobLogs(jobStart, jobEnd, 8, input.experimentName),
      },
    ],
    usage: [
      {
        providerId: input.providerId,
        instanceId: input.instanceId,
        usageStart: provisioned,
        usageEnd: addHours(provisioned, meterHours),
        hours: meterHours,
        sourceRef: "provider-usage-export-" + period,
      },
    ],
    event: {
      externalEventId: "evt-" + input.invoice.lineId,
      source: ({ "PRV-HELIOS": "lambda", "PRV-STRATUS": "coreweave", "PRV-MERIDIAN": "nebius" }[input.providerId] ?? input.providerId.toLowerCase()) + "-billing-feed",
      invoice: {
        id: input.invoice.id,
        providerId: input.providerId,
        invoiceNumber: input.invoice.number,
        period,
        issuedAt: addHours(terminated, 72),
      },
      line: {
        id: input.invoice.lineId,
        externalLineId: input.invoice.lineId,
        lineType: "instance",
        instanceId: input.instanceId,
        reservationId: null,
        description: input.instanceType + " on-demand " + input.instanceId + ": " + input.billedHours + " h x " + money(input.rateCents),
        quantity: input.billedHours,
        unit: "instance-hour",
        unitPriceCents: input.rateCents,
        amountCents,
        period,
        serviceStart: provisioned,
        serviceEnd: addHours(provisioned, Math.max(meterHours, input.billedHours)),
      },
    },
  };
}

export interface ReservationCaseInput {
  reservationId: string;
  ownerProjectId: string;
  requestedBy: string;
  gpuCount: number;
  hours: number;
  rateCents: number;
  startAt: string;
  period: string;
  ownerAccountableForIdle: boolean;
  internalTerms: string;
  invoice: { id: string; number: string; lineId: string };
  jobs: {
    jobId: string;
    experimentId: string;
    experimentName: string;
    projectId: string;
    owner: string;
    gpus: number;
    startOffsetH: number;
    hours: number;
  }[];
}

export function buildReservationCase(input: ReservationCaseInput): ScenarioData {
  const committed = input.gpuCount * input.hours * input.rateCents;
  const endAt = addHours(input.startAt, input.hours);
  const expMap = new Map<string, (typeof experiments.$inferInsert)>();
  for (const j of input.jobs) {
    expMap.set(j.experimentId, {
      id: j.experimentId,
      projectId: j.projectId,
      name: j.experimentName,
      owner: j.owner,
      description: j.experimentName + " (tracked in Weights & Biases)",
      tracker: "wandb",
    });
  }
  return {
    experiments: [...expMap.values()],
    reservations: [
      {
        id: input.reservationId,
        providerId: "PRV-STRATUS",
        ownerProjectId: input.ownerProjectId,
        requestedBy: input.requestedBy,
        gpuType: "H100 80GB",
        gpuCount: input.gpuCount,
        hours: input.hours,
        rateCentsPerGpuHour: input.rateCents,
        committedCents: committed,
        startAt: input.startAt,
        endAt,
        period: input.period,
        ownerAccountableForIdle: input.ownerAccountableForIdle,
        internalTerms: input.internalTerms,
      },
    ],
    instances: [],
    lifecycle: [],
    jobs: input.jobs.map((j) => {
      const start = addHours(input.startAt, j.startOffsetH);
      const end = addHours(start, j.hours);
      return {
        id: j.jobId,
        experimentId: j.experimentId,
        instanceId: null,
        reservationId: input.reservationId,
        submittedBy: j.owner,
        gpus: j.gpus,
        startedAt: start,
        endedAt: end,
        status: "COMPLETED",
        logs: jobLogs(start, end, j.gpus, j.experimentName),
      };
    }),
    usage: [],
    event: {
      externalEventId: "evt-" + input.invoice.lineId,
      source: "coreweave-billing-feed",
      invoice: { id: input.invoice.id, providerId: "PRV-STRATUS", invoiceNumber: input.invoice.number, period: input.period, issuedAt: addHours(endAt, 48) },
      line: {
        id: input.invoice.lineId,
        externalLineId: input.invoice.lineId,
        lineType: "reservation",
        instanceId: null,
        reservationId: input.reservationId,
        description:
          "Reserved capacity " + input.reservationId + ": " + input.gpuCount + " x H100 for " + input.hours + " h at " + money(input.rateCents) + "/GPU-h",
        quantity: input.gpuCount * input.hours,
        unit: "gpu-hour",
        unitPriceCents: input.rateCents,
        amountCents: committed,
        period: input.period,
        serviceStart: input.startAt,
        serviceEnd: endAt,
      },
    },
  };
}

/** Write simulated source-system records, then ingest the invoice line. */
export function ingestCase(ctx: AppContext, data: ScenarioData): IngestionResult {
  tx(ctx, () => {
    authorize(ctx, ACTOR.simulator, "environment:simulate");
    if (data.experiments.length) ctx.db.insert(experiments).values(data.experiments).onConflictDoNothing().run();
    if (data.reservations.length) ctx.db.insert(reservations).values(data.reservations).run();
    if (data.instances.length) ctx.db.insert(gpuInstances).values(data.instances).run();
    if (data.lifecycle.length) ctx.db.insert(lifecycleEvents).values(data.lifecycle).run();
    if (data.jobs.length) ctx.db.insert(computeJobs).values(data.jobs).run();
    if (data.usage.length) ctx.db.insert(providerUsage).values(data.usage).run();
    appendAudit(ctx, {
      actorId: ACTOR.simulator,
      action: "simulator.write_source_records",
      category: "system",
      targetType: "invoice_line",
      targetId: data.event.line.id,
      details: {
        note: "Simulated source-system data (scheduler, infrastructure controller, provider meter, experiment tracker).",
        instances: data.instances.map((i) => i.id),
        reservations: data.reservations.map((r) => r.id),
        jobs: data.jobs.map((j) => j.id),
      },
    });
  });
  return ingestBillingEvent(ctx, data.event);
}

export type ScenarioKey = "overbilling" | "shared_allocation" | "next_month_shared" | "early_job_end" | "custom" | "duplicate";

export interface CustomScenarioParams {
  providerId: "PRV-HELIOS" | "PRV-MERIDIAN";
  projectId: string;
  provisionedHours: number;
  jobHours: number;
  billedHours: number;
  rateCents?: number | null;
}

function suffix(ctx: AppContext, key: string) {
  const n = Number(nextId(ctx, "SIM-" + key, 1).split("-").pop());
  return { n, s: n === 1 ? "" : "-" + n };
}

export function buildScenario(ctx: AppContext, key: Exclude<ScenarioKey, "duplicate">, params?: CustomScenarioParams): ScenarioData {
  const { n, s } = suffix(ctx, key);
  switch (key) {
    case "overbilling":
      return buildInstanceCase({
        key: "s1" + s,
        providerId: "PRV-HELIOS",
        instanceId: "i-hel-4471" + s,
        instanceType: "h100.8x",
        projectId: "PRJ-FLM",
        experimentId: "exp-flm-moe-ablation-07" + s,
        experimentName: "MoE routing ablation 07",
        owner: "Dr. Maya Chen",
        provisionedAt: "2026-10-14T08:00:00.000Z",
        lifecycleHours: 24,
        jobHours: 22,
        billedHours: 36,
        meterHours: 36,
        rateCents: 10_000,
        invoice: { id: "INV-HEL-2026-10-118" + s, number: "HEL-2026-10-118" + s, lineId: "HEL-2026-10-118" + s + "-L3" },
        jobId: "job-88213" + s,
        terminationRef: "hel-api-req-7f3a91" + s,
      });
    case "early_job_end":
      return buildInstanceCase({
        key: "early" + s,
        providerId: "PRV-HELIOS",
        instanceId: "i-hel-4530" + s,
        instanceType: "h100.8x",
        projectId: "PRJ-INF",
        experimentId: "exp-inf-kv-cache-" + n,
        experimentName: "KV-cache quantization study",
        owner: "Diego Alvarez",
        provisionedAt: "2026-10-18T07:00:00.000Z",
        lifecycleHours: 24,
        jobHours: 18,
        billedHours: 24,
        rateCents: 10_000,
        invoice: { id: "INV-HEL-2026-10-124" + s, number: "HEL-2026-10-124" + s, lineId: "HEL-2026-10-124" + s + "-L1" },
        jobId: "job-88402" + s,
      });
    case "shared_allocation":
      return buildReservationCase({
        reservationId: "RSV-2210" + s,
        ownerProjectId: "PRJ-FLM",
        requestedBy: "Dr. Maya Chen",
        gpuCount: 16,
        hours: 155,
        rateCents: 500,
        startAt: "2026-10-06T00:00:00.000Z",
        period: "2026-10",
        ownerAccountableForIdle: true,
        internalTerms:
          "Reserved by Frontier Language Models for the MoE scaling sprint. The reserving team accepts financial responsibility for reserved capacity, including unused hours. Other teams may borrow idle capacity.",
        invoice: { id: "INV-STR-2026-10-044" + s, number: "STR-2026-10-044" + s, lineId: "STR-2026-10-044" + s + "-L1" },
        jobs: [
          { jobId: "job-88101" + s, experimentId: "exp-flm-moe-scale-a" + s, experimentName: "MoE scaling run A", projectId: "PRJ-FLM", owner: "Dr. Maya Chen", gpus: 8, startOffsetH: 0, hours: 60 },
          { jobId: "job-88102" + s, experimentId: "exp-flm-moe-scale-b" + s, experimentName: "MoE scaling run B", projectId: "PRJ-FLM", owner: "Jonah Brooks", gpus: 8, startOffsetH: 60, hours: 45 },
          { jobId: "job-88103" + s, experimentId: "exp-flm-moe-eval" + s, experimentName: "MoE evaluation sweep", projectId: "PRJ-FLM", owner: "Jonah Brooks", gpus: 4, startOffsetH: 75, hours: 69 },
          { jobId: "job-88111" + s, experimentId: "exp-mmp-vlm-pretrain" + s, experimentName: "VLM pretraining warmup", projectId: "PRJ-MMP", owner: "Ravi Shah", gpus: 8, startOffsetH: 0, hours: 70 },
          { jobId: "job-88112" + s, experimentId: "exp-mmp-vlm-sft" + s, experimentName: "VLM supervised finetune", projectId: "PRJ-MMP", owner: "Lena Ortiz", gpus: 4, startOffsetH: 70, hours: 77 },
        ],
      });
    case "next_month_shared":
      return buildReservationCase({
        reservationId: "RSV-2291" + s,
        ownerProjectId: "PRJ-MMP",
        requestedBy: "Ravi Shah",
        gpuCount: 16,
        hours: 120,
        rateCents: 525,
        startAt: "2026-11-03T00:00:00.000Z",
        period: "2026-11",
        ownerAccountableForIdle: true,
        internalTerms:
          "Reserved by Multimodal Perception for VLM evaluation. The reserving team accepts financial responsibility for reserved capacity, including unused hours. RL and Agents may borrow idle capacity.",
        invoice: { id: "INV-STR-2026-11-007" + s, number: "STR-2026-11-007" + s, lineId: "STR-2026-11-007" + s + "-L1" },
        jobs: [
          { jobId: "job-89001" + s, experimentId: "exp-mmp-vlm-eval" + s, experimentName: "VLM evaluation harness", projectId: "PRJ-MMP", owner: "Ravi Shah", gpus: 8, startOffsetH: 0, hours: 120 },
          { jobId: "job-89011" + s, experimentId: "exp-rla-tool-use" + s, experimentName: "Tool-use policy training", projectId: "PRJ-RLA", owner: "Elena Petrova", gpus: 8, startOffsetH: 24, hours: 72 },
        ],
      });
    case "custom": {
      if (!params) throw new ControlError("Custom scenario needs parameters", "INVALID_INPUT", "FAILED");
      const meridian = params.providerId === "PRV-MERIDIAN";
      const provisioned = Math.max(0.5, Math.min(240, params.provisionedHours));
      const billed = Math.max(0.5, Math.min(480, params.billedHours));
      const jobHours = Math.max(0.1, Math.min(provisioned, params.jobHours));
      return buildInstanceCase({
        key: "custom" + n,
        providerId: params.providerId,
        instanceId: (meridian ? "i-mer-" : "i-hel-") + (5100 + n),
        instanceType: meridian ? "h200.8x" : "h100.8x",
        projectId: params.projectId,
        experimentId: "exp-custom-" + n,
        experimentName: "Judge-defined experiment " + n,
        owner: "Demo user",
        provisionedAt: "2026-10-20T09:00:00.000Z",
        lifecycleHours: provisioned,
        jobHours,
        billedHours: billed,
        meterHours: billed,
        rateCents: params.rateCents && params.rateCents > 0 ? Math.round(params.rateCents) : meridian ? 12_000 : 10_000,
        invoice: {
          id: "INV-CUSTOM-" + n,
          number: (meridian ? "MER" : "HEL") + "-2026-10-9" + String(n).padStart(2, "0"),
          lineId: "CUSTOM-" + n + "-L1",
        },
        jobId: "job-custom-" + n,
      });
    }
  }
}

/** Demo control entry point. Every scenario uses the real ingestion pipeline. */
export function runScenario(ctx: AppContext, key: ScenarioKey, params?: CustomScenarioParams) {
  if (key === "duplicate") {
    const last = ctx.db.select().from(ingestionEvents).orderBy(desc(ingestionEvents.id)).get();
    if (!last) throw new ControlError("No billing event has been ingested yet", "INVALID_INPUT", "FAILED");
    return ingestBillingEvent(ctx, last.payload);
  }
  return ingestCase(ctx, buildScenario(ctx, key, params));
}
