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
            : "Sending the controller's rationale on " + proposal.id + " to the Policy Analyst, then back to the Cost Accountant.",
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
        assignAgent(ctx, item.id, ACTOR.policy);
        enqueueJob(ctx, {
          workItemId: item.id,
          kind: "AGENT_RUN",
          agentId: ACTOR.policy,
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

  // Disputes go out through the Vendor Liaison, who asks the ledger gateway to submit them.
  markProposal(ctx, proposal.id, "APPROVED", authorization);
  assignAgent(ctx, item.id, ACTOR.vendorLiaison);
  enqueueJob(ctx, { workItemId: item.id, kind: "AGENT_RUN", agentId: ACTOR.vendorLiaison, payload: { trigger: "dispute_approved", approvalId: approval.id } });
}

/** The approved dispute proposal and its approval for a work item, if any. */
export function approvedDispute(ctx: AppContext, item: WorkItemRow) {
  const proposal = ctx.db
    .select()
    .from(proposals)
    .where(eq(proposals.workItemId, item.id))
    .all()
    .filter((p) => p.kind === "VENDOR_DISPUTE" && (p.status === "APPROVED" || p.status === "EXECUTED"))
    .sort((a, b) => b.version - a.version)[0];
  if (!proposal) return null;
  const approval = ctx.db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.subjectId, proposal.id))
    .all()
    .find((a) => a.status === "APPROVED");
  return approval ? { proposal, approval } : null;
}

/**
 * Submit an approved dispute through the ledger gateway. Called by the Vendor Liaison's
 * send tool; the gateway checks the controller approval itself.
 */
export function submitApprovedDispute(ctx: AppContext, item: WorkItemRow, letter: string) {
  if (item.state !== "APPROVED") throw new ControlError("Work item is " + item.state + "; only approved disputes can be sent.", "STATE_MACHINE");
  const found = approvedDispute(ctx, item);
  if (!found || found.proposal.status !== "APPROVED") throw new ControlError("No controller-approved dispute to send.", "APPROVAL_REQUIRED");
  const { proposal, approval } = found;
  const dispute = proposal.payload.dispute;
  if (!dispute) throw new ControlError("Dispute proposal has no dispute payload", "INVALID_PROPOSAL", "FAILED");
  const decider = getActor(ctx, approval.decidedBy ?? "")?.name ?? approval.decidedBy;
  const authorization = "Approval " + approval.id + " by " + decider;
  authorize(ctx, ACTOR.ledger, "dispute:submit");
  const provider = ctx.db.select().from(providers).where(eq(providers.id, dispute.providerId)).get();
  const disputeId = nextId(ctx, "DSP", 6001);
  const vendorReference = (provider?.shortName ?? "VND").toUpperCase() + "-CASE-" + disputeId.split("-")[1];
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
      vendorReference,
      submittedAt: nowIso(),
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
    details: { amountCents: dispute.disputedCents, provider: provider?.name ?? dispute.providerId, letterChars: letter.length },
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
  return { disputeId, vendorReference, provider: provider?.name ?? dispute.providerId, disputedCents: dispute.disputedCents };
}

/** Simulated vendor reply to a submitted dispute. Records the reply and hands it to the Vendor Liaison. */
export function recordVendorResponse(ctx: AppContext, input: { workItemId: string; outcome: "accept" | "deny" }) {
  return guard(ctx, { actorId: ACTOR.vendor, action: "vendor.respond", workItemId: input.workItemId }, () => {
    authorize(ctx, ACTOR.vendor, "vendor:respond");
    const item = getWorkItem(ctx, input.workItemId);
    if (item.state !== "DISPUTED") throw new ControlError("Work item is not awaiting a vendor response", "STATE_MACHINE");
    const dispute = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, item.id)).get();
    if (!dispute || dispute.status !== "SUBMITTED") throw new ControlError("No open dispute", "STATE_MACHINE");
    const provider = ctx.db.select().from(providers).where(eq(providers.id, dispute.providerId)).get();
    const accepted = input.outcome === "accept";
    const memoRef = "CM-" + dispute.id.split("-")[1];
    ctx.db
      .update(vendorDisputes)
      .set(accepted ? { status: "CREDIT_ACCEPTED", vendorReference: memoRef, resolvedAt: nowIso() } : { status: "DENIED", resolvedAt: nowIso() })
      .where(eq(vendorDisputes.id, dispute.id))
      .run();
    recordActivity(ctx, {
      workItemId: item.id,
      actorId: ACTOR.vendor,
      type: "DISPUTE",
      status: accepted ? "ok" : "error",
      title: accepted
        ? (provider?.name ?? "Vendor") + " accepted " + dispute.id + " and issued credit memo " + memoRef
        : (provider?.name ?? "Vendor") + " denied " + dispute.id,
      summary: "The Vendor Liaison will read the reply and close the case.",
      changes: ["Dispute " + dispute.id + (accepted ? " CREDIT_ACCEPTED" : " DENIED")],
    });
    assignAgent(ctx, item.id, ACTOR.vendorLiaison);
    enqueueJob(ctx, { workItemId: item.id, kind: "AGENT_RUN", agentId: ACTOR.vendorLiaison, payload: { trigger: "vendor_reply", outcome: input.outcome } });
    return { outcome: accepted ? "CREDIT_ACCEPTED" : "DENIED" };
  });
}

/** Book the vendor's answer and close the work item. Called by the Vendor Liaison's close tool. */
export function closeDispute(ctx: AppContext, item: WorkItemRow) {
  if (item.state !== "DISPUTED") throw new ControlError("Work item is " + item.state + ", not DISPUTED.", "STATE_MACHINE");
  const dispute = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, item.id)).get();
  if (!dispute || dispute.status === "SUBMITTED") throw new ControlError("The vendor has not replied yet.", "WORKFLOW");
  const accepted = dispute.status === "CREDIT_ACCEPTED";
  const lines: JournalLineDraft[] = accepted
    ? [
        { accountCode: ACCOUNTS.AP, projectId: null, debitCents: dispute.amountCents, creditCents: 0, memo: "Vendor credit " + dispute.vendorReference },
        { accountCode: ACCOUNTS.CLEARING, projectId: null, debitCents: 0, creditCents: dispute.amountCents, memo: "Vendor credit " + dispute.vendorReference },
      ]
    : allocationJournal(
        [{ projectId: item.ownerProjectId ?? "", basis: "Dispute denied", weight: 1, amountCents: dispute.amountCents }],
        "Disputed amount upheld by vendor",
      );
  const outcome = accepted ? "VENDOR_CREDIT" : "CHARGE_UPHELD";
  const { entryId } = postJournalEntry(ctx, {
    actorId: ACTOR.ledger,
    period: item.period,
    memo: accepted ? "Record vendor credit for " + dispute.id : "Charge upheld after " + dispute.id + " denied",
    source: "experiment_ledger",
    authorization: "Vendor response to " + dispute.id + " under approval " + dispute.approvalId,
    idempotencyKey: "dispute:" + dispute.id + ":" + (accepted ? "accept" : "deny"),
    lines,
    workItemId: item.id,
    invoiceLineId: item.invoiceLineId,
    proposalId: dispute.proposalId,
    approvalId: dispute.approvalId,
  });
  resolveReconciliation(ctx, item.invoiceLineId, outcome);
  setWorkItemOutcome(ctx, item.id, outcome);
  transitionWorkItem(ctx, item.id, "RESOLVED", ACTOR.orchestrator, "Vendor responded to " + dispute.id);
  return { outcome, entryId, dispute };
}
