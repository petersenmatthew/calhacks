import { eq } from "drizzle-orm";
import { recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { nowIso, type AppContext } from "../context";
import { workItems, workItemTransitions } from "../db/schema";
import { canTransition, type WorkItemState } from "../domain/states";
import { ControlError } from "../security/errors";

export type WorkItemRow = typeof workItems.$inferSelect;

export function getWorkItem(ctx: AppContext, id: string): WorkItemRow {
  const row = ctx.db.select().from(workItems).where(eq(workItems.id, id)).get();
  if (!row) throw new ControlError("Work item " + id + " does not exist", "NOT_FOUND", "FAILED");
  return row;
}

/** Move a work item to a new state. Invalid transitions throw a ControlError. */
export function transitionWorkItem(
  ctx: AppContext,
  id: string,
  to: WorkItemState,
  actorId: string,
  reason: string,
) {
  const item = getWorkItem(ctx, id);
  const from = item.state as WorkItemState;
  if (from === to) return item;
  if (!canTransition(from, to)) {
    throw new ControlError("Invalid state transition " + from + " -> " + to + " for " + id, "STATE_MACHINE");
  }
  const ts = nowIso();
  ctx.db
    .update(workItems)
    .set({ state: to, updatedAt: ts, resolvedAt: to === "RESOLVED" ? ts : item.resolvedAt })
    .where(eq(workItems.id, id))
    .run();
  ctx.db.insert(workItemTransitions).values({ workItemId: id, fromState: from, toState: to, actorId, reason, createdAt: ts }).run();
  appendAudit(ctx, {
    actorId,
    action: "work_item.transition",
    category: "write",
    targetType: "work_item",
    targetId: id,
    workItemId: id,
    rule: "STATE_MACHINE",
    details: { from, to, reason },
  });
  recordActivity(ctx, {
    workItemId: id,
    actorId,
    type: "STATE_CHANGE",
    status: "info",
    title: from + " -> " + to,
    summary: reason,
    changes: ["State: " + from + " -> " + to],
  });
  return getWorkItem(ctx, id);
}

export function assignAgent(ctx: AppContext, id: string, agentId: string | null) {
  ctx.db.update(workItems).set({ assignedAgentId: agentId, updatedAt: nowIso() }).where(eq(workItems.id, id)).run();
}
