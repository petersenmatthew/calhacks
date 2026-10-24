import { and, eq } from "drizzle-orm";
import { recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { nextId, nowIso, type AppContext } from "../context";
import { approvalRequests, policies, precedents, projects, proposals } from "../db/schema";
import { METHOD_LABELS, type AllocationMethod } from "../domain/allocation";
import { formatCents } from "../domain/money";
import { ACTOR, getActor } from "../security/actors";
import { authorize, guard } from "../security/authorize";
import { ControlError } from "../security/errors";
import { enqueueJob } from "./jobs";
import { CONTROLLER } from "../comms/directory";
import { mention, postSlack, reactSlack, taskLink } from "../comms/outbox";

export type ApprovalRow = typeof approvalRequests.$inferSelect;
export type Decision = "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";

export function createApprovalRequest(
  ctx: AppContext,
  input: { workItemId: string; subjectType: "PROPOSAL" | "POLICY"; subjectId: string; requestedBy: string; summary: string },
) {
  const id = nextId(ctx, "AP", 3001);
  ctx.db
    .insert(approvalRequests)
    .values({
      id,
      workItemId: input.workItemId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      requestedBy: input.requestedBy,
      requiredRole: "controller",
      status: "PENDING",
      summary: input.summary,
      createdAt: nowIso(),
    })
    .run();
  appendAudit(ctx, {
    actorId: input.requestedBy,
    action: "approval.request",
    category: "decision",
    targetType: input.subjectType.toLowerCase(),
    targetId: input.subjectId,
    workItemId: input.workItemId,
    approvalId: id,
    rule: "APPROVAL_REQUIRED",
    details: { summary: input.summary },
  });
  postSlack(ctx, {
    channel: "finance-approvals",
    event: "approval.requested",
    workItemId: input.workItemId,
    ref: id,
    mentions: [CONTROLLER],
    text:
      mention(CONTROLLER) + " " + (getActor(ctx, input.requestedBy)?.name ?? input.requestedBy) + " needs your approval on " +
      taskLink(ctx, input.workItemId) + " (" + id + "): " + input.summary,
  });
  recordActivity(ctx, {
    workItemId: input.workItemId,
    actorId: ACTOR.orchestrator,
    type: "APPROVAL_REQUEST",
    status: "pending",
    title:
      "System requested controller approval for " +
      (input.subjectType === "POLICY" ? "policy " : "proposal ") +
      input.subjectId,
    summary: input.summary,
    changes: ["Approval " + id + " pending (controller)"],
  });
  return id;
}

export interface DecisionInput {
  approvalId: string;
  actorId: string;
  decision: Decision;
  reason?: string | null;
  directive?: string | null;
  /** Set alongside an approval: the Budget Analyst changes this project's monthly budget. */
  budget?: { projectId: string; monthlyCents: number } | null;
}

/**
 * A human decision on an approval request. Enforces role, segregation of
 * duties, and finality, then queues the workflow to resume.
 */
export function decideApproval(ctx: AppContext, input: DecisionInput) {
  const approval = ctx.db.select().from(approvalRequests).where(eq(approvalRequests.id, input.approvalId)).get();
  return guard(
    ctx,
    {
      actorId: input.actorId,
      action: "approval.decide",
      workItemId: approval?.workItemId,
      targetType: "approval",
      targetId: input.approvalId,
    },
    () => {
      authorize(ctx, input.actorId, "approval:decide");
      if (!approval) throw new ControlError("Approval " + input.approvalId + " does not exist", "NOT_FOUND", "FAILED");
      if (approval.status !== "PENDING") {
        throw new ControlError("Approval " + approval.id + " was already decided", "APPROVAL_FINAL");
      }
      if (approval.requestedBy === input.actorId) {
        throw new ControlError("The requester cannot decide their own approval", "SOD");
      }
      const reason = input.reason?.trim() ?? "";
      if (input.decision !== "APPROVED" && reason.length < 3) {
        throw new ControlError("A reason is required to reject or request changes", "REASON_REQUIRED", "FAILED");
      }
      if (input.budget && (input.decision !== "APPROVED" || approval.subjectType !== "PROPOSAL")) {
        throw new ControlError("A budget change can only ride along with an approved proposal", "STATE_MACHINE", "FAILED");
      }
      if (input.budget && !ctx.db.select().from(projects).where(eq(projects.id, input.budget.projectId)).get()) {
        throw new ControlError("Unknown project " + input.budget.projectId, "NOT_FOUND", "FAILED");
      }
      const actor = getActor(ctx, input.actorId);
      const ts = nowIso();
      let subjectLabel = approval.subjectId;

      if (approval.subjectType === "PROPOSAL") {
        const proposal = ctx.db.select().from(proposals).where(eq(proposals.id, approval.subjectId)).get();
        if (!proposal || proposal.status !== "PENDING_APPROVAL") {
          throw new ControlError("Proposal is not awaiting approval", "STATE_MACHINE");
        }
        if (proposal.createdBy === input.actorId) throw new ControlError("Proposer cannot approve their own proposal", "SOD");
        ctx.db
          .update(proposals)
          .set({ status: input.decision === "APPROVED" ? "APPROVED" : input.decision, updatedAt: ts })
          .where(eq(proposals.id, proposal.id))
          .run();
        subjectLabel = proposal.id + " v" + proposal.version + " (" + formatCents(proposal.payload.totalCents) + ")";
        if (input.decision !== "APPROVED") {
          const precedentId = nextId(ctx, "PREC", 201);
          const methodLabel = METHOD_LABELS[proposal.method as AllocationMethod] ?? proposal.method;
          ctx.db
            .insert(precedents)
            .values({
              id: precedentId,
              kind: "controller_decision",
              decidedAt: ts,
              decidedBy: input.actorId,
              title:
                "Controller " + (input.decision === "REJECTED" ? "rejected" : "requested changes to") + " '" +
                methodLabel + "' on " + approval.workItemId,
              summary: reason,
              tags: [
                proposal.kind === "VENDOR_DISPUTE" ? "vendor_dispute" : "allocation",
                "shared_reservation",
                proposal.method,
                ...(input.directive ? [input.directive] : []),
                "controller_correction",
              ],
              details: {
                approvalId: approval.id,
                proposalId: proposal.id,
                rejectedMethod: proposal.method,
                directive: input.directive ?? null,
              },
              source: "controller_decision",
              workItemId: approval.workItemId,
            })
            .run();
        }
      } else {
        const policy = ctx.db.select().from(policies).where(eq(policies.id, approval.subjectId)).get();
        if (!policy || policy.status !== "PROPOSED") throw new ControlError("Policy is not awaiting approval", "STATE_MACHINE");
        if (policy.proposedBy === input.actorId) throw new ControlError("Proposer cannot approve their own policy", "SOD");
        subjectLabel = policy.policyKey + " v" + policy.version;
        if (input.decision === "APPROVED") {
          ctx.db
            .update(policies)
            .set({ status: "SUPERSEDED" })
            .where(and(eq(policies.policyKey, policy.policyKey), eq(policies.status, "APPROVED")))
            .run();
          ctx.db
            .update(policies)
            .set({ status: "APPROVED", approvedBy: input.actorId, approvalId: approval.id, approvedAt: ts })
            .where(eq(policies.id, policy.id))
            .run();
        } else {
          ctx.db.update(policies).set({ status: "REJECTED" }).where(eq(policies.id, policy.id)).run();
        }
      }

      ctx.db
        .update(approvalRequests)
        .set({
          status: input.decision,
          decidedBy: input.actorId,
          decisionReason: reason || null,
          directive: input.directive ?? null,
          decidedAt: ts,
        })
        .where(eq(approvalRequests.id, approval.id))
        .run();

      appendAudit(ctx, {
        actorId: input.actorId,
        action: "approval.decide",
        category: "decision",
        targetType: approval.subjectType.toLowerCase(),
        targetId: approval.subjectId,
        workItemId: approval.workItemId,
        approvalId: approval.id,
        policyId: approval.subjectType === "POLICY" ? approval.subjectId : null,
        rule: "SOD",
        details: { decision: input.decision, reason: reason || null, directive: input.directive ?? null, budget: input.budget ?? null },
      });
      const verb =
        input.decision === "APPROVED" ? "approved" : input.decision === "REJECTED" ? "rejected" : "requested changes to";
      recordActivity(ctx, {
        workItemId: approval.workItemId,
        actorId: input.actorId,
        type: "APPROVAL_DECISION",
        status: input.decision === "APPROVED" ? "ok" : "error",
        title: (actor?.name ?? input.actorId) + " " + verb + " " + subjectLabel,
        summary: reason || null,
        changes: ["Approval " + approval.id + ": " + input.decision],
      });

      // Slack: mark the original request so the channel shows the outcome at a glance, and say what happens next in its thread.
      const proposalKind =
        approval.subjectType === "PROPOSAL" ? ctx.db.select({ kind: proposals.kind }).from(proposals).where(eq(proposals.id, approval.subjectId)).get()?.kind : null;
      const next =
        input.decision !== "APPROVED"
          ? "Back to " + (getActor(ctx, approval.requestedBy)?.name ?? "the agent") + " to rework."
          : approval.subjectType === "POLICY"
            ? "The policy is active for new cases."
            : proposalKind === "VENDOR_DISPUTE"
              ? "The Vendor Liaison is sending the dispute."
              : "The ledger gateway is posting it.";
      reactSlack(ctx, {
        on: { event: "approval.requested", ref: approval.id },
        emoji: input.decision === "APPROVED" ? "white_check_mark" : input.decision === "REJECTED" ? "x" : "leftwards_arrow_with_hook",
        event: "approval.decided",
        workItemId: approval.workItemId,
      });
      postSlack(ctx, {
        channel: "finance-approvals",
        event: "approval.decided",
        workItemId: approval.workItemId,
        ref: approval.id,
        text:
          (input.decision === "APPROVED" ? "Approved" : input.decision === "REJECTED" ? "Rejected" : "Changes requested") + " by " +
          (actor?.name ?? input.actorId) + (reason ? ": \u201c" + reason.slice(0, 300) + "\u201d" : ".") + " " + next,
      });

      if (approval.subjectType === "PROPOSAL") {
        enqueueJob(ctx, { workItemId: approval.workItemId, kind: "EXECUTE_DECISION", payload: { approvalId: approval.id } });
        // Queued after the decision runs, so the Budget Analyst finds the item approved.
        if (input.budget) {
          enqueueJob(ctx, {
            workItemId: approval.workItemId,
            kind: "AGENT_RUN",
            agentId: ACTOR.budget,
            payload: { trigger: "controller_note", approvalId: approval.id, note: reason || null, ...input.budget },
          });
        }
      } else if (input.decision === "APPROVED") {
        recordActivity(ctx, {
          workItemId: approval.workItemId,
          actorId: ACTOR.orchestrator,
          type: "POLICY",
          title: "Policy " + subjectLabel + " is now active",
          summary: "Future cases matching this policy will use it. The previous version is superseded.",
          changes: ["Policy " + approval.subjectId + " APPROVED"],
        });
      }
      return { approvalId: approval.id, decision: input.decision };
    },
  );
}
