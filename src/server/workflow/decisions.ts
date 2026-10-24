import { eq } from "drizzle-orm";
import { recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { nextId, nowIso, type AppContext } from "../context";
import { approvalRequests, providers, proposals, vendorDisputes, type JournalLineDraft } from "../db/schema";
import { formatCents } from "../domain/money";
import { ACTOR, getActor } from "../security/actors";
import { authorize, guard } from "../security/authorize";
import { ControlError } from "../security/errors";
import { enqueueJob } from "./jobs";
import { ACCOUNTS, allocationJournal, postJournalEntry } from "./ledger";
import { resolveReconciliation, setReconciliationOutcome, setWorkItemOutcome } from "./reconciliation";
import { assignAgent, getWorkItem, transitionWorkItem, type WorkItemRow } from "./work-items";

type ProposalRow = typeof proposals.$inferSelect;
type ApprovalRow = typeof approvalRequests.$inferSelect;

function markProposal(ctx: AppContext, id: string, status: string, authorization?: string) {
  ctx.db
    .update(proposals)
    .set({ status, updatedAt: nowIso(), ...(authorization ? { authorization } : {}) })
    .where(eq(proposals.id, id))
    .run();
}

/** Resume a workflow after a controller decision. Runs as a durable job. */
export function executeDecision(ctx: AppContext, approvalId: string) {
  const approval = ctx.db.select().from(approvalRequests).where(eq(approvalRequests.id, approvalId)).get();
  if (!approval) throw new Error("Unknown approval " + approvalId);
  return guard(
    ctx,
    { actorId: ACTOR.orchestrator, action: "workflow.resume", workItemId: approval.workItemId, targetType: "approval", targetId: approvalId },
    () => {
      authorize(ctx, ACTOR.orchestrator, "workflow:orchestrate");
      const item = getWorkItem(ctx, approval.workItemId);
      const proposal = ctx.db.select().from(proposals).where(eq(proposals.id, approval.subjectId)).get();
      if (!proposal || item.state !== "NEEDS_APPROVAL") {
        recordActivity(ctx, {
          workItemId: item.id,
          actorId: ACTOR.orchestrator,
          type: "SYSTEM",
          status: "info",
          title: "Skipped stale decision " + approvalId,
          summary: "Work item is " + item.state + ".",
        });
        return;
      }
      recordActivity(ctx, {
        workItemId: item.id,
        actorId: ACTOR.orchestrator,
        type: "SYSTEM",
        status: "info",
        title: "Workflow resumed after controller decision " + approvalId,
        summary:
          approval.status === "APPROVED"
            ? "Executing approved " + proposal.kind.toLowerCase().replace("_", " ") + " through the ledger gateway."
            : "Returning " + proposal.id + " to the Finance Agent with the controller's rationale.",
      });
      if (approval.status === "APPROVED") {
        executeApprovedProposal(ctx, item, proposal, approval);
      } else {
        transitionWorkItem(
          ctx,
          item.id,
          "INVESTIGATING",
          ACTOR.orchestrator,
          "Controller " + approval.status.toLowerCase().replace("_", " ") + ": " + (approval.decisionReason ?? ""),
        );
        assignAgent(ctx, item.id, ACTOR.finance);
        enqueueJob(ctx, {
          workItemId: item.id,
          kind: "AGENT_RUN",
          agentId: ACTOR.finance,
          payload: { trigger: "controller_feedback", approvalId },
        });
      }
    },
  );
}

function executeApprovedProposal(ctx: AppContext, item: WorkItemRow, proposal: ProposalRow, approval: ApprovalRow) {
  const decider = getActor(ctx, approval.decidedBy ?? "")?.name ?? approval.decidedBy;
  const authorization = "Approval " + approval.id + " by " + decider;
  transitionWorkItem(ctx, item.id, "APPROVED", ACTOR.orchestrator, authorization);

  if (proposal.kind === "ALLOCATION") {
    postJournalEntry(ctx, {
      actorId: ACTOR.ledger,
      period: item.period,
      memo: "Allocate " + item.invoiceLineId + " per " + proposal.id + " v" + proposal.version,
      source: "experiment_ledger",
      authorization,
      idempotencyKey: "proposal:" + proposal.id,
      lines: proposal.payload.journalPreview,
      workItemId: item.id,
      invoiceLineId: item.invoiceLineId,
      proposalId: proposal.id,
      approvalId: approval.id,
    });
    markProposal(ctx, proposal.id, "EXECUTED", authorization);
    transitionWorkItem(ctx, item.id, "POSTED", ACTOR.ledger, "Balanced allocation entry posted");
    const outcome = item.type === "SHARED_ALLOCATION" ? "ALLOCATED_WITH_APPROVAL" : "CHARGE_ALLOCATED";
    resolveReconciliation(ctx, item.invoiceLineId, outcome);
    setWorkItemOutcome(ctx, item.id, outcome);
    transitionWorkItem(ctx, item.id, "RESOLVED", ACTOR.orchestrator, "Reconciliation complete");
    return;
  }

  const dispute = proposal.payload.dispute;
  if (!dispute) throw new ControlError("Dispute proposal has no dispute payload", "INVALID_PROPOSAL", "FAILED");
  authorize(ctx, ACTOR.ledger, "dispute:submit");
  const provider = ctx.db.select().from(providers).where(eq(providers.id, dispute.providerId)).get();
  const disputeId = nextId(ctx, "DSP", 6001);
  const ts = nowIso();
  ctx.db
    .insert(vendorDisputes)
    .values({
      id: disputeId,
      workItemId: item.id,
      providerId: dispute.providerId,
      invoiceLineId: dispute.invoiceLineId,
      proposalId: proposal.id,
      approvalId: approval.id,
      amountCents: dispute.disputedCents,
      status: "SUBMITTED",
      reason: dispute.reason,
      vendorReference: (provider?.shortName ?? "VND").toUpperCase() + "-CASE-" + disputeId.split("-")[1],
      submittedAt: ts,
    })
    .run();
  appendAudit(ctx, {
    actorId: ACTOR.ledger,
    action: "dispute.submit",
    category: "posting",
    targetType: "vendor_dispute",
    targetId: disputeId,
    workItemId: item.id,
    approvalId: approval.id,
    rule: "APPROVAL",
    evidenceIds: proposal.evidenceIds,
    details: { amountCents: dispute.disputedCents, provider: provider?.name ?? dispute.providerId },
  });
  recordActivity(ctx, {
    workItemId: item.id,
    actorId: ACTOR.ledger,
    type: "DISPUTE",
    title: "Submitted dispute " + disputeId + " for " + formatCents(dispute.disputedCents) + " to " + (provider?.name ?? "vendor"),
    summary:
      "Sent through the vendor portal (simulated). Accounts payable stays at " + formatCents(dispute.invoicedCents) +
      " until the vendor issues a credit.",
    evidenceIds: proposal.evidenceIds,
    changes: ["Dispute " + disputeId + " SUBMITTED"],
  });
  if (dispute.undisputedCents > 0) {
    postJournalEntry(ctx, {
      actorId: ACTOR.ledger,
      period: item.period,
      memo: "Allocate undisputed portion of " + item.invoiceLineId,
      source: "experiment_ledger",
      authorization,
      idempotencyKey: "proposal:" + proposal.id + ":undisputed",
      lines: proposal.payload.journalPreview,
      workItemId: item.id,
      invoiceLineId: item.invoiceLineId,
      proposalId: proposal.id,
      approvalId: approval.id,
    });
  }
  markProposal(ctx, proposal.id, "EXECUTED", authorization);
  transitionWorkItem(ctx, item.id, "DISPUTED", ACTOR.ledger, "Dispute " + disputeId + " submitted; awaiting vendor response");
  setReconciliationOutcome(ctx, item.invoiceLineId, "DISPUTE_SUBMITTED");
  setWorkItemOutcome(ctx, item.id, "DISPUTE_SUBMITTED");
}

/** Simulated vendor response to a submitted dispute. */
export function recordVendorResponse(ctx: AppContext, input: { workItemId: string; outcome: "accept" | "deny" }) {
  return guard(ctx, { actorId: ACTOR.vendor, action: "vendor.respond", workItemId: input.workItemId }, () => {
    authorize(ctx, ACTOR.vendor, "vendor:respond");
    const item = getWorkItem(ctx, input.workItemId);
    if (item.state !== "DISPUTED") throw new ControlError("Work item is not awaiting a vendor response", "STATE_MACHINE");
    const dispute = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, item.id)).get();
    if (!dispute || dispute.status !== "SUBMITTED") throw new ControlError("No open dispute", "STATE_MACHINE");
    const provider = ctx.db.select().from(providers).where(eq(providers.id, dispute.providerId)).get();
    const ts = nowIso();
    let lines: JournalLineDraft[];
    let outcome: string;
    if (input.outcome === "accept") {
      const memoRef = "CM-" + dispute.id.split("-")[1];
      ctx.db
        .update(vendorDisputes)
        .set({ status: "CREDIT_ACCEPTED", vendorReference: memoRef, resolvedAt: ts })
        .where(eq(vendorDisputes.id, dispute.id))
        .run();
      recordActivity(ctx, {
        workItemId: item.id,
        actorId: ACTOR.vendor,
        type: "DISPUTE",
        title: (provider?.name ?? "Vendor") + " accepted " + dispute.id + " and issued credit memo " + memoRef,
        summary: "Only now is the liability reduced by " + formatCents(dispute.amountCents) + ".",
        changes: ["Dispute " + dispute.id + " CREDIT_ACCEPTED"],
      });
      lines = [
        { accountCode: ACCOUNTS.AP, projectId: null, debitCents: dispute.amountCents, creditCents: 0, memo: "Vendor credit " + memoRef },
        { accountCode: ACCOUNTS.CLEARING, projectId: null, debitCents: 0, creditCents: dispute.amountCents, memo: "Vendor credit " + memoRef },
      ];
      outcome = "VENDOR_CREDIT";
    } else {
      ctx.db.update(vendorDisputes).set({ status: "DENIED", resolvedAt: ts }).where(eq(vendorDisputes.id, dispute.id)).run();
      recordActivity(ctx, {
        workItemId: item.id,
        actorId: ACTOR.vendor,
        type: "DISPUTE",
        status: "error",
        title: (provider?.name ?? "Vendor") + " denied " + dispute.id,
        summary: "The disputed amount is charged to the owning project under the approved fallback.",
        changes: ["Dispute " + dispute.id + " DENIED"],
      });
      lines = allocationJournal(
        [{ projectId: item.ownerProjectId ?? "", basis: "Dispute denied", weight: 1, amountCents: dispute.amountCents }],
        "Disputed amount upheld by vendor",
      );
      outcome = "CHARGE_UPHELD";
    }
    postJournalEntry(ctx, {
      actorId: ACTOR.ledger,
      period: item.period,
      memo: input.outcome === "accept" ? "Record vendor credit for " + dispute.id : "Charge upheld after " + dispute.id + " denied",
      source: "experiment_ledger",
      authorization: "Vendor response to " + dispute.id + " under approval " + dispute.approvalId,
      idempotencyKey: "dispute:" + dispute.id + ":" + input.outcome,
      lines,
      workItemId: item.id,
      invoiceLineId: item.invoiceLineId,
      proposalId: dispute.proposalId,
      approvalId: dispute.approvalId,
    });
    resolveReconciliation(ctx, item.invoiceLineId, outcome);
    setWorkItemOutcome(ctx, item.id, outcome);
    transitionWorkItem(ctx, item.id, "RESOLVED", ACTOR.orchestrator, "Vendor responded to " + dispute.id);
    return { outcome };
  });
}
