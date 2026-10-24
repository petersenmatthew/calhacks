import { and, eq } from "drizzle-orm";
import { recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { businessAgeMs, businessNowIso, DAY_MS, formatDuration } from "../clock";
import { nowIso, tx, type AppContext } from "../context";
import { approvalRequests, followUps, vendorDisputes, workItems } from "../db/schema";
import { ACTOR, getActor } from "../security/actors";
import { authorize } from "../security/authorize";
import { enqueueJob } from "./jobs";
import { CFO, CONTROLLER } from "../comms/directory";
import { dmSlack, mention, postSlack, taskLink } from "../comms/outbox";

/*
 * Time-based follow-ups. Nobody clicks these: the scheduler checks the
 * business clock and acts when something has waited too long. Each action is
 * keyed, so it happens once, and every one is audited.
 */

export const FOLLOW_UP_RULES = {
  approvalReminderMs: 1 * DAY_MS,
  approvalEscalationMs: 3 * DAY_MS,
  disputeChaseMs: 14 * DAY_MS,
  disputeEscalationMs: 30 * DAY_MS,
};

export const FOLLOW_UP_TRIGGERS = new Set(["dispute_follow_up", "dispute_escalation"]);

type Kind = "APPROVAL_REMINDER" | "APPROVAL_ESCALATION" | "DISPUTE_CHASE" | "DISPUTE_ESCALATION";

function has(ctx: AppContext, key: string) {
  return Boolean(ctx.db.select({ id: followUps.id }).from(followUps).where(eq(followUps.key, key)).get());
}

function record(
  ctx: AppContext,
  input: { key: string; kind: Kind | string; workItemId: string | null; subjectId: string; actorId: string; details: Record<string, unknown> },
) {
  ctx.db
    .insert(followUps)
    .values({ ...input, businessAt: businessNowIso(ctx), createdAt: nowIso() })
    .onConflictDoNothing()
    .run();
}

export function followUpsFor(ctx: AppContext, subjectId: string) {
  return ctx.db.select().from(followUps).where(eq(followUps.subjectId, subjectId)).all();
}

export function recordFollowUp(
  ctx: AppContext,
  input: { key: string; kind: string; workItemId: string | null; subjectId: string; actorId: string; details: Record<string, unknown> },
) {
  record(ctx, input);
}

function remindApprovals(ctx: AppContext) {
  let acted = 0;
  const pending = ctx.db.select().from(approvalRequests).where(eq(approvalRequests.status, "PENDING")).all();
  const controller = getActor(ctx, ACTOR.controller)?.name ?? "the controller";
  const backup = getActor(ctx, ACTOR.cfo);
  for (const a of pending) {
    const age = businessAgeMs(ctx, a.createdAt);
    const subject = (a.subjectType === "POLICY" ? "policy " : "proposal ") + a.subjectId;
    if (age >= FOLLOW_UP_RULES.approvalReminderMs && !has(ctx, "approval-remind:" + a.id)) {
      tx(ctx, () => {
        record(ctx, {
          key: "approval-remind:" + a.id,
          kind: "APPROVAL_REMINDER",
          workItemId: a.workItemId,
          subjectId: a.id,
          actorId: ACTOR.scheduler,
          details: { to: ACTOR.controller, channel: "slack", waited: formatDuration(age) },
        });
        appendAudit(ctx, {
          actorId: ACTOR.scheduler,
          action: "approval.remind",
          category: "system",
          targetType: "approval",
          targetId: a.id,
          workItemId: a.workItemId,
          approvalId: a.id,
          rule: "FOLLOW_UP",
          details: { waitedMs: age, to: ACTOR.controller },
        });
        dmSlack(ctx, {
          to: CONTROLLER,
          event: "approval.reminder",
          workItemId: a.workItemId,
          ref: a.id,
          text: "Reminder: " + a.id + " on " + taskLink(ctx, a.workItemId) + " has waited " + formatDuration(age) + " for your decision. " + a.summary,
        });
        recordActivity(ctx, {
          workItemId: a.workItemId,
          actorId: ACTOR.scheduler,
          type: "APPROVAL_REQUEST",
          status: "pending",
          title: "Reminded " + controller + ": " + a.id + " has waited " + formatDuration(age),
          summary: "Approval of " + subject + " is still open. Sent as a Slack DM.",
        });
      });
      acted += 1;
    }
    if (age >= FOLLOW_UP_RULES.approvalEscalationMs && !has(ctx, "approval-escalate:" + a.id)) {
      tx(ctx, () => {
        record(ctx, {
          key: "approval-escalate:" + a.id,
          kind: "APPROVAL_ESCALATION",
          workItemId: a.workItemId,
          subjectId: a.id,
          actorId: ACTOR.scheduler,
          details: { to: ACTOR.cfo, channel: "slack", waited: formatDuration(age) },
        });
        appendAudit(ctx, {
          actorId: ACTOR.scheduler,
          action: "approval.escalate",
          category: "system",
          targetType: "approval",
          targetId: a.id,
          workItemId: a.workItemId,
          approvalId: a.id,
          rule: "FOLLOW_UP",
          details: { waitedMs: age, to: ACTOR.cfo },
        });
        dmSlack(ctx, {
          to: CFO,
          event: "approval.escalated",
          workItemId: a.workItemId,
          ref: a.id,
          text:
            "Escalation: " + a.id + " on " + taskLink(ctx, a.workItemId) + " has waited " + formatDuration(age) + " without a decision from " +
            mention(CONTROLLER) + ". You can decide it as backup approver. " + a.summary,
        });
        postSlack(ctx, {
          channel: "finance-approvals",
          event: "approval.escalated",
          workItemId: a.workItemId,
          ref: a.id,
          mentions: [CFO, CONTROLLER],
          text: a.id + " (" + taskLink(ctx, a.workItemId) + ") escalated to " + mention(CFO) + " after " + formatDuration(age) + " waiting on " + mention(CONTROLLER) + ".",
        });
        recordActivity(ctx, {
          workItemId: a.workItemId,
          actorId: ACTOR.scheduler,
          type: "APPROVAL_REQUEST",
          status: "pending",
          title: "Escalated " + a.id + " to " + (backup?.name ?? "the backup approver") + " after " + formatDuration(age) + " without a decision",
          summary:
            (backup ? backup.name + " (" + backup.title + ")" : "The backup approver") +
            " can now decide it. The requester still cannot approve their own request.",
        });
      });
      acted += 1;
    }
  }
  return acted;
}

function chaseDisputes(ctx: AppContext) {
  let acted = 0;
  const open = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.status, "SUBMITTED")).all();
  for (const d of open) {
    const item = ctx.db.select().from(workItems).where(and(eq(workItems.id, d.workItemId), eq(workItems.state, "DISPUTED"))).get();
    if (!item) continue;
    const age = businessAgeMs(ctx, d.submittedAt);
    const busy = ctx.sqlite
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE work_item_id = ? AND status IN ('queued','running')")
      .get(item.id) as { n: number };
    if (busy.n > 0) continue;
    // The vendor answered, or the controller is deciding: nothing to chase.
    const replied = ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM vendor_messages WHERE dispute_id = ? AND direction = 'inbound'").get(d.id) as { n: number };
    if (replied.n > 0 || item.pendingQuestion) continue;
    if (age >= FOLLOW_UP_RULES.disputeChaseMs && !has(ctx, "dispute-chase:" + d.id)) {
      tx(ctx, () => {
        record(ctx, {
          key: "dispute-chase:" + d.id,
          kind: "DISPUTE_CHASE",
          workItemId: item.id,
          subjectId: d.id,
          actorId: ACTOR.scheduler,
          details: { daysOpen: Math.floor(age / DAY_MS) },
        });
        appendAudit(ctx, {
          actorId: ACTOR.scheduler,
          action: "dispute.follow_up.schedule",
          category: "system",
          targetType: "vendor_dispute",
          targetId: d.id,
          workItemId: item.id,
          rule: "FOLLOW_UP",
          details: { waitedMs: age },
        });
        recordActivity(ctx, {
          workItemId: item.id,
          actorId: ACTOR.scheduler,
          type: "SYSTEM",
          status: "info",
          title: d.id + " has had no vendor response for " + formatDuration(age) + "; assigned to the Vendor Liaison to follow up",
        });
        enqueueJob(ctx, {
          workItemId: item.id,
          kind: "AGENT_RUN",
          agentId: ACTOR.vendorLiaison,
          payload: { trigger: "dispute_follow_up", disputeId: d.id, daysOpen: Math.floor(age / DAY_MS) },
        });
      });
      acted += 1;
      continue;
    }
    if (age >= FOLLOW_UP_RULES.disputeEscalationMs && has(ctx, "dispute-chase:" + d.id) && !has(ctx, "dispute-escalate:" + d.id)) {
      tx(ctx, () => {
        record(ctx, {
          key: "dispute-escalate:" + d.id,
          kind: "DISPUTE_ESCALATION",
          workItemId: item.id,
          subjectId: d.id,
          actorId: ACTOR.scheduler,
          details: { daysOpen: Math.floor(age / DAY_MS) },
        });
        recordActivity(ctx, {
          workItemId: item.id,
          actorId: ACTOR.scheduler,
          type: "SYSTEM",
          status: "info",
          title: d.id + " is still unanswered after " + formatDuration(age) + "; Vendor Liaison asked to escalate",
        });
        enqueueJob(ctx, {
          workItemId: item.id,
          kind: "AGENT_RUN",
          agentId: ACTOR.vendorLiaison,
          payload: { trigger: "dispute_escalation", disputeId: d.id, daysOpen: Math.floor(age / DAY_MS) },
        });
      });
      acted += 1;
    }
  }
  return acted;
}

/** Run every time-based rule once. Safe to call repeatedly. */
export function runFollowUps(ctx: AppContext) {
  authorize(ctx, ACTOR.scheduler, "followup:create");
  return remindApprovals(ctx) + chaseDisputes(ctx);
}
