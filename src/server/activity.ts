import { eq } from "drizzle-orm";
import { notifyChange, nowIso, type AppContext } from "./context";
import { activityEvents, workItems } from "./db/schema";

export type ActivityType =
  | "INGESTION"
  | "WORK_ITEM"
  | "AGENT_STARTED"
  | "AGENT_FINISHED"
  | "TOOL_CALL"
  | "FINDING"
  | "HANDOFF"
  | "PROPOSAL"
  | "APPROVAL_REQUEST"
  | "APPROVAL_DECISION"
  | "STATE_CHANGE"
  | "POSTING"
  | "DISPUTE"
  | "POLICY"
  | "ERROR"
  | "DENIED"
  | "COMPLETED"
  | "SYSTEM";

export interface ActivityInput {
  workItemId?: string | null;
  runId?: string | null;
  actorId: string;
  type: ActivityType;
  title: string;
  summary?: string | null;
  status?: "ok" | "error" | "denied" | "info" | "pending";
  toolName?: string | null;
  args?: unknown;
  result?: unknown;
  evidenceIds?: string[];
  changes?: string[];
  mode?: string | null;
  durationMs?: number | null;
}

/** Record an observable event. These rows drive the live timeline over SSE. */
export function recordActivity(ctx: AppContext, input: ActivityInput) {
  if (ctx.deferredActivity) {
    ctx.deferredActivity.push(input);
    return null;
  }
  const createdAt = nowIso();
  const row = ctx.db
    .insert(activityEvents)
    .values({
      workItemId: input.workItemId ?? null,
      runId: input.runId ?? null,
      actorId: input.actorId,
      type: input.type,
      title: input.title,
      summary: input.summary ?? null,
      status: input.status ?? "ok",
      toolName: input.toolName ?? null,
      args: input.args ?? null,
      result: input.result ?? null,
      evidenceIds: input.evidenceIds ?? [],
      changes: input.changes ?? [],
      mode: input.mode ?? null,
      durationMs: input.durationMs ?? null,
      createdAt,
    })
    .returning()
    .get();
  if (input.workItemId) {
    const meaningful = !["AGENT_FINISHED", "STATE_CHANGE", "SYSTEM"].includes(input.type);
    ctx.db
      .update(workItems)
      .set(meaningful ? { latestAction: input.title, updatedAt: createdAt } : { updatedAt: createdAt })
      .where(eq(workItems.id, input.workItemId))
      .run();
  }
  notifyChange(ctx, "activity");
  return row;
}

/** Run fn while buffering activity events; returns fn's value and the buffered events. */
export function collectActivity<T>(ctx: AppContext, fn: () => T): { value: T; events: ActivityInput[] } {
  const previous = ctx.deferredActivity;
  ctx.deferredActivity = [];
  try {
    const value = fn();
    return { value, events: ctx.deferredActivity as ActivityInput[] };
  } finally {
    ctx.deferredActivity = previous;
  }
}
