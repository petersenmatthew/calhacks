import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { nextId, nowIso, tx, type AppContext } from "../context";
import {
  ingestionEvents,
  invoiceLines,
  invoices,
  providers,
  reconciliations,
  workItems,
  workItemTransitions,
  type ReconciliationChecks,
} from "../db/schema";
import { formatCents } from "../domain/money";
import { ACTOR } from "../security/actors";
import { authorize, guard } from "../security/authorize";
import { ControlError } from "../security/errors";
import { analyzeInvoiceLine, needsInvestigation, type InvoiceLineRow } from "./checks";
import { enqueueJob } from "./jobs";
import { ACCOUNTS, allocationJournal, postJournalEntry } from "./ledger";
import { getApprovedPolicy, POLICY_KEYS } from "./policies";

export const billingEventSchema = z.object({
  externalEventId: z.string().min(3),
  source: z.string().min(2),
  invoice: z.object({
    id: z.string(),
    providerId: z.string(),
    invoiceNumber: z.string(),
    period: z.string().regex(/^\d{4}-\d{2}$/),
    issuedAt: z.string(),
  }),
  line: z.object({
    id: z.string(),
    externalLineId: z.string(),
    lineType: z.enum(["instance", "reservation"]),
    instanceId: z.string().nullable(),
    reservationId: z.string().nullable(),
    description: z.string(),
    quantity: z.number().positive(),
    unit: z.string(),
    unitPriceCents: z.number().int().nonnegative(),
    amountCents: z.number().int().positive(),
    period: z.string().regex(/^\d{4}-\d{2}$/),
    serviceStart: z.string(),
    serviceEnd: z.string(),
  }),
});

export type BillingEvent = z.infer<typeof billingEventSchema>;

export type IngestionResult =
  | { status: "duplicate"; workItemId: string | null; invoiceLineId: string | null }
  | { status: "auto_matched"; invoiceLineId: string; entryId: string }
  | { status: "work_item_created"; invoiceLineId: string; workItemId: string };

function priorityFor(type: string, checks: ReconciliationChecks) {
  const disc = Math.abs(checks.discrepancyCents);
  if (type === "SHARED_ALLOCATION") return checks.invoicedCents >= 1_000_000 ? 1 : 2;
  if (disc >= 1_000_000) return 0;
  if (disc >= 100_000) return 1;
  if (disc >= 100) return 2;
  return 3;
}

function titleFor(type: string, checks: ReconciliationChecks, providerShort: string) {
  if (checks.kind === "reservation") return "Shared reservation " + checks.reservationId + " needs allocation";
  const codes = new Set(checks.flags.map((f) => f.code));
  if (codes.has("DUPLICATE_CHARGE")) return providerShort + " billed " + checks.instanceId + " twice";
  if (codes.has("MISSING_OWNER")) return "Unattributed GPU charge on " + checks.instanceId;
  if (codes.has("QUANTITY_EXCEEDS_LIFECYCLE")) return providerShort + " billed past instance lifetime on " + checks.instanceId;
  if (codes.has("RATE_MISMATCH")) {
    return providerShort + " rate " + (checks.invoicedRateCents > checks.contractRateCents ? "above" : "below") + " contract on " + checks.instanceId;
  }
  if (codes.has("AMOUNT_VARIANCE")) return "Invoice variance on " + checks.instanceId;
  if (codes.has("IDLE_TIME")) return "Invoice exceeds scheduler runtime on " + checks.instanceId;
  return type + " on " + checks.instanceId;
}

/**
 * Entry point for provider billing events (webhook, feed, or simulator).
 * Idempotent on externalEventId and on the provider's line id.
 */
export function ingestBillingEvent(ctx: AppContext, raw: unknown, actorId: string = ACTOR.ingestion): IngestionResult {
  const event = billingEventSchema.parse(raw);
  const existing = ctx.db
    .select()
    .from(ingestionEvents)
    .where(eq(ingestionEvents.externalEventId, event.externalEventId))
    .get();
  const duplicateLine = existing
    ? null
    : ctx.db.select().from(invoiceLines).where(eq(invoiceLines.externalLineId, event.line.externalLineId)).get();
  if (existing || duplicateLine) {
    const workItemId =
      existing?.workItemId ??
      ctx.db.select().from(workItems).where(eq(workItems.invoiceLineId, duplicateLine?.id ?? "")).get()?.id ??
      null;
    const invoiceLineId = existing?.invoiceLineId ?? duplicateLine?.id ?? null;
    tx(ctx, () => {
      if (existing) {
        ctx.db
          .update(ingestionEvents)
          .set({ duplicateCount: sql`${ingestionEvents.duplicateCount} + 1` })
          .where(eq(ingestionEvents.id, existing.id))
          .run();
      }
      appendAudit(ctx, {
        actorId,
        action: "invoice.ingest.duplicate_ignored",
        category: "system",
        targetType: "ingestion_event",
        targetId: event.externalEventId,
        workItemId,
        rule: "IDEMPOTENCY",
        details: { externalLineId: event.line.externalLineId },
      });
      recordActivity(ctx, {
        workItemId,
        actorId,
        type: "INGESTION",
        status: "info",
        title: "Duplicate billing event ignored (" + event.externalEventId + ")",
        summary: "Already processed. No new work item, journal entry, or dispute was created.",
      });
    });
    return { status: "duplicate", workItemId, invoiceLineId };
  }

  return guard(ctx, { actorId, action: "invoice.ingest", targetType: "invoice_line", targetId: event.line.id }, () => {
    authorize(ctx, actorId, "invoice:ingest");
    if (Math.round(event.line.quantity * event.line.unitPriceCents) !== event.line.amountCents) {
      throw new ControlError("Invoice line amount does not equal quantity x unit price", "INVALID_INPUT", "FAILED");
    }
    const provider = ctx.db.select().from(providers).where(eq(providers.id, event.invoice.providerId)).get();
    if (!provider) throw new ControlError("Unknown provider " + event.invoice.providerId, "INVALID_INPUT", "FAILED");

    ctx.db.insert(invoices).values(event.invoice).onConflictDoNothing().run();
    ctx.db.insert(invoiceLines).values({ ...event.line, invoiceId: event.invoice.id }).run();
    const line = ctx.db.select().from(invoiceLines).where(eq(invoiceLines.id, event.line.id)).get() as InvoiceLineRow;

    // The simulated ERP records the vendor liability for the full invoiced amount.
    postJournalEntry(ctx, {
      actorId: ACTOR.erp,
      period: line.period,
      memo: "Vendor invoice " + event.invoice.invoiceNumber + " / " + line.externalLineId,
      source: "erp_ap",
      authorization: "Vendor invoice recorded in AP (simulated ERP)",
      idempotencyKey: "ap:" + line.id,
      invoiceLineId: line.id,
      lines: [
        { accountCode: ACCOUNTS.CLEARING, projectId: null, debitCents: line.amountCents, creditCents: 0, memo: line.description },
        { accountCode: ACCOUNTS.AP, projectId: null, debitCents: 0, creditCents: line.amountCents, memo: provider.name },
      ],
    });

    const checks = analyzeInvoiceLine(ctx, line);
    let result: IngestionResult;
    if (!needsInvestigation(checks)) {
      result = autoMatch(ctx, line, checks, provider.name);
    } else {
      result = openWorkItem(ctx, line, checks, provider);
    }
    ctx.db
      .insert(ingestionEvents)
      .values({
        externalEventId: event.externalEventId,
        source: event.source,
        receivedAt: nowIso(),
        payload: event as unknown as Record<string, unknown>,
        invoiceLineId: line.id,
        workItemId: result.status === "work_item_created" ? result.workItemId : null,
        outcome: result.status,
      })
      .run();
    appendAudit(ctx, {
      actorId,
      action: "invoice.ingest",
      category: "system",
      targetType: "invoice_line",
      targetId: line.id,
      workItemId: result.status === "work_item_created" ? result.workItemId : null,
      details: {
        externalEventId: event.externalEventId,
        amountCents: line.amountCents,
        outcome: result.status,
        flags: checks.flags.map((f) => f.code),
      },
    });
    return result;
  });
}

function autoMatch(ctx: AppContext, line: InvoiceLineRow, checks: ReconciliationChecks, providerName: string): IngestionResult {
  const policy = getApprovedPolicy(ctx, POLICY_KEYS.autoMatch);
  const owner = checks.kind === "instance" ? checks.ownerProjectIds[0] : checks.ownerProjectId;
  if (!policy || !owner || line.amountCents > policy.rule.autoPostLimitCents) {
    throw new ControlError("Clean line is outside the auto-match policy", "APPROVAL_REQUIRED", "FAILED");
  }
  ctx.db
    .insert(reconciliations)
    .values({
      invoiceLineId: line.id,
      period: line.period,
      status: "MATCHED",
      outcome: "AUTO_MATCHED",
      expectedCents: checks.expectedCents,
      invoicedCents: checks.invoicedCents,
      varianceCents: checks.discrepancyCents,
      checks,
    })
    .run();
  const { entryId } = postJournalEntry(ctx, {
    actorId: ACTOR.ledger,
    period: line.period,
    memo: "Auto-allocate " + line.externalLineId,
    source: "experiment_ledger",
    authorization: "Standing policy " + policy.id,
    idempotencyKey: "auto:" + line.id,
    invoiceLineId: line.id,
    policyId: policy.id,
    lines: allocationJournal([{ projectId: owner, basis: "Single owner, exact match", weight: 1, amountCents: line.amountCents }], "Auto-match " + line.externalLineId),
  });
  ctx.db
    .update(reconciliations)
    .set({ status: "RESOLVED", resolvedAt: nowIso() })
    .where(eq(reconciliations.invoiceLineId, line.id))
    .run();
  recordActivity(ctx, {
    actorId: ACTOR.ingestion,
    type: "INGESTION",
    title: "Auto-matched " + providerName + " " + line.externalLineId + " (" + formatCents(line.amountCents) + ")",
    summary: "Invoice equals contract-supported charge with a single owner. Posted " + entryId + " under " + policy.id + ".",
  });
  return { status: "auto_matched", invoiceLineId: line.id, entryId };
}

function openWorkItem(
  ctx: AppContext,
  line: InvoiceLineRow,
  checks: ReconciliationChecks,
  provider: { id: string; name: string; shortName: string },
): IngestionResult {
  const type = checks.kind === "reservation" ? "SHARED_ALLOCATION" : "BILLING_VARIANCE";
  const id = nextId(ctx, "WI", 1001);
  const ts = nowIso();
  const title = titleFor(type, checks, provider.shortName);
  ctx.db
    .insert(workItems)
    .values({
      id,
      type,
      title,
      period: line.period,
      providerId: provider.id,
      invoiceLineId: line.id,
      instanceId: checks.kind === "instance" ? checks.instanceId : null,
      reservationId: checks.kind === "reservation" ? checks.reservationId : null,
      ownerProjectId: checks.kind === "reservation" ? checks.ownerProjectId : checks.ownerProjectIds.length === 1 ? checks.ownerProjectIds[0] : null,
      amountCents: line.amountCents,
      expectedCents: checks.expectedCents,
      invoicedCents: checks.invoicedCents,
      discrepancyCents: checks.discrepancyCents,
      checks,
      state: "NEW",
      priority: priorityFor(type, checks),
      assignedAgentId: type === "SHARED_ALLOCATION" ? ACTOR.capacity : ACTOR.compute,
      latestAction: "Detected by deterministic checks",
      createdAt: ts,
      updatedAt: ts,
    })
    .run();
  ctx.db
    .insert(workItemTransitions)
    .values({ workItemId: id, fromState: null, toState: "NEW", actorId: ACTOR.ingestion, reason: "Opened by reconciliation checks", createdAt: ts })
    .run();
  ctx.db
    .insert(reconciliations)
    .values({
      invoiceLineId: line.id,
      period: line.period,
      status: "EXCEPTION",
      outcome: "INVESTIGATING",
      expectedCents: checks.expectedCents,
      invoicedCents: checks.invoicedCents,
      varianceCents: checks.discrepancyCents,
      checks,
      workItemId: id,
    })
    .run();
  appendAudit(ctx, {
    actorId: ACTOR.ingestion,
    action: "work_item.create",
    category: "write",
    targetType: "work_item",
    targetId: id,
    workItemId: id,
    details: { type, flags: checks.flags.map((f) => f.code), discrepancyCents: checks.discrepancyCents },
  });
  recordActivity(ctx, {
    workItemId: id,
    actorId: ACTOR.ingestion,
    type: "WORK_ITEM",
    title: "Opened " + id + ": " + title,
    summary: checks.flags.map((f) => f.message).join(" "),
    changes: ["Work item " + id + " created (NEW)", "Assigned to " + (type === "SHARED_ALLOCATION" ? "Capacity Planner" : "GPU Auditor")],
    result: { flags: checks.flags },
  });
  enqueueJob(ctx, {
    workItemId: id,
    kind: "AGENT_RUN",
    agentId: type === "SHARED_ALLOCATION" ? ACTOR.capacity : ACTOR.compute,
    payload: { trigger: "new_work_item" },
  });
  return { status: "work_item_created", invoiceLineId: line.id, workItemId: id };
}
