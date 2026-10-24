import { eq, inArray } from "drizzle-orm";
import { recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { nextId, nowIso, type AppContext } from "../context";
import {
  approvalRequests,
  journalEntries,
  journalLines,
  ledgerAccounts,
  policies,
  projects,
  proposals,
  type AllocationLine,
  type JournalLineDraft,
} from "../db/schema";
import { formatCents } from "../domain/money";
import { ACTOR, getActor } from "../security/actors";
import { authorize, guard } from "../security/authorize";
import { ControlError } from "../security/errors";
import { roleHas } from "../security/permissions";
import { enqueueAgentOnce } from "./jobs";

export const ACCOUNTS = {
  AP: "2000",
  COMPUTE_EXPENSE: "6100",
  CLEARING: "6990",
} as const;

export interface PostingInput {
  actorId: string;
  period: string;
  memo: string;
  source: "erp_ap" | "experiment_ledger";
  authorization: string;
  idempotencyKey: string;
  lines: JournalLineDraft[];
  workItemId?: string | null;
  invoiceLineId?: string | null;
  proposalId?: string | null;
  approvalId?: string | null;
  policyId?: string | null;
}

/** Dr compute expense per project, Cr clearing for the total. */
export function allocationJournal(lines: AllocationLine[], memo: string): JournalLineDraft[] {
  const total = lines.reduce((s, l) => s + l.amountCents, 0);
  return [
    ...lines.map((l) => ({
      accountCode: ACCOUNTS.COMPUTE_EXPENSE,
      projectId: l.projectId,
      debitCents: l.amountCents,
      creditCents: 0,
      memo,
    })),
    { accountCode: ACCOUNTS.CLEARING, projectId: null, debitCents: 0, creditCents: total, memo },
  ];
}

export function validateBalanced(lines: JournalLineDraft[]) {
  if (lines.length < 2) throw new ControlError("A journal entry needs at least two lines", "BALANCED_ENTRY");
  let debits = 0;
  let credits = 0;
  for (const line of lines) {
    const okDebit = Number.isInteger(line.debitCents) && line.debitCents >= 0;
    const okCredit = Number.isInteger(line.creditCents) && line.creditCents >= 0;
    if (!okDebit || !okCredit || (line.debitCents > 0) === (line.creditCents > 0)) {
      throw new ControlError("Each journal line must have exactly one positive integer side", "BALANCED_ENTRY");
    }
    debits += line.debitCents;
    credits += line.creditCents;
  }
  if (debits !== credits || debits <= 0) {
    throw new ControlError(
      "Unbalanced journal entry: debits " + formatCents(debits) + " vs credits " + formatCents(credits),
      "BALANCED_ENTRY",
    );
  }
  return debits;
}

function verifyAuthorization(ctx: AppContext, input: PostingInput) {
  if (input.source === "erp_ap") {
    authorize(ctx, input.actorId, "invoice:record");
    return;
  }
  authorize(ctx, input.actorId, "ledger:post");
  if (input.approvalId) {
    const approval = ctx.db.select().from(approvalRequests).where(eq(approvalRequests.id, input.approvalId)).get();
    if (!approval || approval.status !== "APPROVED") {
      throw new ControlError("Approval " + input.approvalId + " is not approved", "APPROVAL_REQUIRED");
    }
    if (input.proposalId && approval.subjectId !== input.proposalId) {
      throw new ControlError("Approval " + approval.id + " does not cover proposal " + input.proposalId, "APPROVAL_REQUIRED");
    }
    const decider = approval.decidedBy ? getActor(ctx, approval.decidedBy) : undefined;
    if (!decider || decider.kind !== "human" || !roleHas(decider.role, "approval:decide")) {
      throw new ControlError("Approval " + approval.id + " was not decided by an authorized controller", "SOD");
    }
    if (approval.decidedBy === approval.requestedBy) {
      throw new ControlError("Requester approved their own request", "SOD");
    }
    if (input.proposalId) {
      const proposal = ctx.db.select().from(proposals).where(eq(proposals.id, input.proposalId)).get();
      if (proposal && proposal.createdBy === approval.decidedBy) {
        throw new ControlError("Proposer approved their own proposal", "SOD");
      }
    }
    return;
  }
  if (input.policyId) {
    const policy = ctx.db.select().from(policies).where(eq(policies.id, input.policyId)).get();
    const approver = policy?.approvedBy ? getActor(ctx, policy.approvedBy) : undefined;
    if (!policy || policy.status !== "APPROVED" || !approver || approver.kind !== "human") {
      throw new ControlError("Policy " + input.policyId + " is not an approved standing authorization", "APPROVAL_REQUIRED");
    }
    return;
  }
  throw new ControlError("Posting requires an approved request or an approved policy", "APPROVAL_REQUIRED");
}

/**
 * The only path to the ledger. Validates permission, authorization, balance,
 * accounts, and idempotency, then writes the entry in one transaction.
 */
export function postJournalEntry(ctx: AppContext, input: PostingInput) {
  return guard(
    ctx,
    { actorId: input.actorId, action: "ledger.post", workItemId: input.workItemId, targetType: "journal_entry" },
    () => {
      verifyAuthorization(ctx, input);
      const existing = ctx.db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.idempotencyKey, input.idempotencyKey))
        .get();
      if (existing) {
        appendAudit(ctx, {
          actorId: input.actorId,
          action: "ledger.post.duplicate_ignored",
          category: "posting",
          targetType: "journal_entry",
          targetId: existing.id,
          workItemId: input.workItemId ?? null,
          rule: "IDEMPOTENCY",
          details: { idempotencyKey: input.idempotencyKey },
        });
        return { entryId: existing.id, duplicate: true };
      }
      const total = validateBalanced(input.lines);
      const codes = [...new Set(input.lines.map((l) => l.accountCode))];
      const known = ctx.db.select().from(ledgerAccounts).where(inArray(ledgerAccounts.code, codes)).all();
      if (known.length !== codes.length) throw new ControlError("Unknown ledger account in entry", "CHART_OF_ACCOUNTS");
      const projectIds = [...new Set(input.lines.map((l) => l.projectId).filter((p): p is string => Boolean(p)))];
      if (projectIds.length) {
        const found = ctx.db.select().from(projects).where(inArray(projects.id, projectIds)).all();
        if (found.length !== projectIds.length) throw new ControlError("Unknown project on journal line", "CHART_OF_ACCOUNTS");
      }
      const entryId = nextId(ctx, "JE", 7001);
      ctx.db
        .insert(journalEntries)
        .values({
          id: entryId,
          period: input.period,
          postedAt: nowIso(),
          memo: input.memo,
          source: input.source,
          workItemId: input.workItemId ?? null,
          invoiceLineId: input.invoiceLineId ?? null,
          proposalId: input.proposalId ?? null,
          approvalId: input.approvalId ?? null,
          policyId: input.policyId ?? null,
          authorization: input.authorization,
          idempotencyKey: input.idempotencyKey,
          postedBy: input.actorId,
          totalCents: total,
        })
        .run();
      input.lines.forEach((line, i) => {
        ctx.db.insert(journalLines).values({ entryId, lineNo: i + 1, ...line }).run();
      });
      // Anything charged to a research team goes to the Budget Analyst for a burn check.
      const charged = input.lines.some((l) => l.projectId && l.debitCents > 0);
      if (input.source === "experiment_ledger" && input.workItemId && charged) {
        enqueueAgentOnce(ctx, input.workItemId, ACTOR.budget, { trigger: "posting", entryId });
      }
      appendAudit(ctx, {
        actorId: input.actorId,
        action: input.source === "erp_ap" ? "ledger.record_vendor_invoice" : "ledger.post",
        category: "posting",
        targetType: "journal_entry",
        targetId: entryId,
        workItemId: input.workItemId ?? null,
        policyId: input.policyId ?? null,
        approvalId: input.approvalId ?? null,
        rule: input.approvalId ? "APPROVAL" : input.policyId ? "STANDING_POLICY" : "ERP_RECORDING",
        details: {
          memo: input.memo,
          authorization: input.authorization,
          debitsCents: total,
          creditsCents: total,
          proposalId: input.proposalId ?? null,
          lines: input.lines.length,
        },
      });
      if (input.workItemId) {
        recordActivity(ctx, {
          workItemId: input.workItemId,
          actorId: input.actorId,
          type: "POSTING",
          title: "Posted " + entryId + " (" + formatCents(total) + " Dr = " + formatCents(total) + " Cr)",
          summary: input.memo + ". Authorization: " + input.authorization,
          changes: ["Journal entry " + entryId + " posted"],
        });
      }
      return { entryId, duplicate: false };
    },
  );
}

export const POSTING_ACTOR = ACTOR.ledger;
