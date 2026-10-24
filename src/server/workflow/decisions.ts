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
import { contractForProvider } from "./checks";
import { buildDisputeEvidence, renderEvidenceCsv, renderEvidenceText } from "./dispute-evidence";
import { CONTROLLER, leadFor } from "../comms/directory";
import { mention, postSlack, queueEmail, reactSlack, taskLink, vendorEmail } from "../comms/outbox";

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The plain-text letter in a readable HTML wrapper; monospace keeps the evidence columns aligned. */
export function renderLetterHtml(text: string) {
  const [letter, ...rest] = text.split("\n\nEVIDENCE\n");
  const evidence = rest.join("\n\nEVIDENCE\n");
  return (
    '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5;color:#18181b">' +
    escapeHtml(letter).replace(/\n/g, "<br>") +
    (evidence
      ? '<h3 style="margin:24px 0 8px;font-size:13px;letter-spacing:.04em;color:#52525b">EVIDENCE</h3><pre style="font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#f4f4f5;padding:12px;border-radius:8px;white-space:pre-wrap">' +
        escapeHtml(evidence) +
        "</pre>"
      : "") +
    "</div>"
  );
}

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
export function submitApprovedDispute(ctx: AppContext, item: WorkItemRow, letter: { subject: string; message: string }) {
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
  // The application attaches the evidence pack and clause text; the agent only writes the cover letter.
  const contract = contractForProvider(ctx, dispute.providerId);
  const evidence = item.checks.kind === "instance" ? buildDisputeEvidence(ctx, item) : null;
  const subject = "[" + vendorReference + "] " + (letter.subject || "Billing dispute " + formatCents(dispute.disputedCents));
  const body = letter.message.trim() + (evidence ? "\n\n" + renderEvidenceText(evidence, contract.name + " (" + contract.id + ")") : "") +
    "\n\nPlease quote " + vendorReference + " in your reply.";
  const to = vendorEmail(ctx, dispute.providerId);
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
      letterSubject: subject,
      letterBody: body,
      evidence: evidence as unknown as Record<string, unknown> | null,
      sentTo: to,
      emailStatus: "queued",
    })
    .run();
  queueEmail(ctx, {
    to,
    subject,
    text: body,
    html: renderLetterHtml(body),
    event: "dispute.sent",
    workItemId: item.id,
    ref: disputeId,
    attachments: evidence ? [{ filename: disputeId + "-evidence.csv", content: renderEvidenceCsv(evidence), contentType: "text/csv" }] : [],
  });
  postSlack(ctx, {
    channel: "vendor-disputes",
    event: "dispute.sent",
    workItemId: item.id,
    ref: disputeId,
    mentions: [CONTROLLER],
    text:
      "Vendor Liaison sent " + (provider?.name ?? "the vendor") + " dispute " + disputeId + " for *" + formatCents(dispute.disputedCents) + "* on " +
      taskLink(ctx, item.id) + " (approved by " + decider + "). Letter and evidence emailed to " + to + ". FYI " + mention(CONTROLLER),
  });
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
    details: { caseReference: vendorReference, amountCents: dispute.disputedCents, provider: provider?.name ?? dispute.providerId, sentTo: to, subject, clauses: dispute.clauseRefs },
  });
  recordActivity(ctx, {
    workItemId: item.id,
    actorId: ACTOR.ledger,
    type: "DISPUTE",
    title: "Submitted dispute " + disputeId + " for " + formatCents(dispute.disputedCents) + " to " + (provider?.name ?? "vendor"),
    summary:
      "Letter and evidence emailed to " + to + ". Accounts payable stays at " + formatCents(dispute.invoicedCents) +
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
      .set(accepted ? { status: "CREDIT_ACCEPTED", creditMemoRef: memoRef, resolvedAt: nowIso() } : { status: "DENIED", resolvedAt: nowIso() })
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
    postSlack(ctx, {
      channel: "vendor-disputes",
      event: "dispute.reply",
      workItemId: item.id,
      ref: dispute.id,
      text: accepted
        ? (provider?.name ?? "The vendor") + " accepted " + dispute.id + " and issued credit memo " + memoRef + " for *" + formatCents(dispute.amountCents) + "* (" + taskLink(ctx, item.id) + "). Vendor Liaison is booking it."
        : (provider?.name ?? "The vendor") + " denied " + dispute.id + " (" + formatCents(dispute.amountCents) + ", " + taskLink(ctx, item.id) + "). Vendor Liaison is booking the charge to the owning team.",
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
  // A partial credit (agreed by the controller) books the credit and charges the rest to the owning project.
  const credited = accepted ? Math.min(dispute.creditedCents ?? dispute.amountCents, dispute.amountCents) : 0;
  const upheld = dispute.amountCents - credited;
  const lines: JournalLineDraft[] = [
    ...(credited > 0
      ? [
          { accountCode: ACCOUNTS.AP, projectId: null, debitCents: credited, creditCents: 0, memo: "Vendor credit " + (dispute.creditMemoRef ?? dispute.vendorReference) + " on " + dispute.vendorReference },
          { accountCode: ACCOUNTS.CLEARING, projectId: null, debitCents: 0, creditCents: credited, memo: "Vendor credit " + (dispute.creditMemoRef ?? dispute.vendorReference) + " on " + dispute.vendorReference },
        ]
      : []),
    ...(upheld > 0
      ? allocationJournal(
          [{ projectId: item.ownerProjectId ?? "", basis: "Dispute denied", weight: 1, amountCents: upheld }],
          credited > 0 ? "Disputed amount not credited by vendor" : "Disputed amount upheld by vendor",
        )
      : []),
  ];
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
  const lead = leadFor(item.ownerProjectId);
  reactSlack(ctx, {
    on: { event: "dispute.sent", ref: dispute.id },
    emoji: !accepted ? "x" : upheld > 0 ? "handshake" : "white_check_mark",
    event: "dispute.closed",
    workItemId: item.id,
  });
  postSlack(ctx, {
    channel: "vendor-disputes",
    event: "dispute.closed",
    workItemId: item.id,
    ref: dispute.id,
    mentions: accepted && upheld === 0 ? [] : [CONTROLLER, ...(lead ? [lead.handle] : [])],
    text: accepted && upheld > 0
      ? "Closed " + dispute.id + ": " + formatCents(credited) + " partial credit booked and the remaining " + formatCents(upheld) + " charged to " +
        (lead ? mention(lead.handle) + "'s team" : "the owning team") + " (" + entryId + "). " + taskLink(ctx, item.id)
      : accepted
      ? "Closed " + dispute.id + ": " + formatCents(dispute.amountCents) + " credit booked (" + entryId + "). What Atlas owes the vendor dropped by that amount. " + taskLink(ctx, item.id)
      : "Closed " + dispute.id + ": the vendor upheld the charge, so " + formatCents(dispute.amountCents) + " was charged to " + (lead ? mention(lead.handle) + "'s team" : "the owning team") +
        " (" + entryId + "). " + mention(CONTROLLER) + " can reopen it with the vendor. " + taskLink(ctx, item.id),
  });
  return { outcome, entryId, dispute };
}
