import { and, asc, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import { notifyChange, nowIso, txImmediate, type AppContext } from "../context";
import { jobs, workItems } from "../db/schema";
import { getFocusWorkItem, getRunMode, pausedAgents } from "../settings";

export type JobRow = typeof jobs.$inferSelect;
export type JobKind = "AGENT_RUN" | "EXECUTE_DECISION";

export function enqueueJob(
  ctx: AppContext,
  input: { workItemId: string; kind: JobKind; agentId?: string | null; payload?: Record<string, unknown> },
) {
  const row = ctx.db
    .insert(jobs)
    .values({
      workItemId: input.workItemId,
      kind: input.kind,
      agentId: input.agentId ?? null,
      payload: input.payload ?? {},
      status: "queued",
      createdAt: nowIso(),
    })
    .returning()
    .get();
  notifyChange(ctx, "jobs");
  return row;
}

/**
 * The case the team is working on in one-at-a-time mode: the case with a running
 * job, else the focused case, else the oldest case the team still owns. A case
 * waiting on the vendor has left the team's hands until the vendor replies.
 */
export function activeWorkItemId(ctx: AppContext): string | null {
  const running = ctx.sqlite.prepare("SELECT work_item_id AS id FROM jobs WHERE status = 'running' ORDER BY id LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (running) return running.id;
  const inFlight = (id: string | null) =>
    ctx.sqlite
      .prepare(
        "SELECT w.id FROM work_items w WHERE (? IS NULL OR w.id = ?) AND (w.state NOT IN ('RESOLVED', 'DISPUTED') " +
          "OR EXISTS (SELECT 1 FROM jobs j WHERE j.work_item_id = w.id AND j.status = 'queued')) ORDER BY w.id LIMIT 1",
      )
      .get(id, id) as { id: string } | undefined;
  const focus = getFocusWorkItem(ctx);
  return (focus ? inFlight(focus)?.id : undefined) ?? inFlight(null)?.id ?? null;
}

/**
 * Claim the oldest queued job whose work item has no running job and whose agent
 * is not paused. In one-at-a-time mode, only the active case's jobs are claimed.
 */
export function claimNextJob(ctx: AppContext): JobRow | null {
  return txImmediate(ctx, () => {
    const only = getRunMode(ctx) === "one" ? activeWorkItemId(ctx) : undefined;
    if (only === null) return null;
    const busyWorkItems = ctx.db.select({ id: jobs.workItemId }).from(jobs).where(eq(jobs.status, "running"));
    const paused = pausedAgents(ctx);
    const candidate = ctx.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "queued"),
          // A vendor reply on a disputed case is handled right away, not after whatever case is on screen.
          only
            ? or(
                eq(jobs.workItemId, only),
                inArray(jobs.workItemId, ctx.db.select({ id: workItems.id }).from(workItems).where(eq(workItems.state, "DISPUTED"))),
              )
            : undefined,
          notInArray(jobs.workItemId, busyWorkItems),
          paused.length ? or(isNull(jobs.agentId), notInArray(jobs.agentId, paused)) : undefined,
        ),
      )
      .orderBy(asc(jobs.id))
      .limit(1)
      .get();
    if (!candidate) return null;
    ctx.db
      .update(jobs)
      .set({ status: "running", attempts: candidate.attempts + 1, startedAt: nowIso() })
      .where(eq(jobs.id, candidate.id))
      .run();
    return { ...candidate, status: "running", attempts: candidate.attempts + 1 };
  });
}

export function finishJob(ctx: AppContext, id: number, status: "done" | "failed" | "cancelled" | "queued", error?: string) {
  ctx.db
    .update(jobs)
    .set({ status, error: error ?? null, finishedAt: status === "queued" ? null : nowIso() })
    .where(eq(jobs.id, id))
    .run();
}

/** After a restart, jobs left running by a dead process are queued again. */
export function recoverInterruptedJobs(ctx: AppContext) {
  const result = ctx.db.update(jobs).set({ status: "queued" }).where(eq(jobs.status, "running")).run();
  return result.changes;
}

export function hasPendingJobs(ctx: AppContext) {
  const row = ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get() as { n: number };
  return row.n > 0;
}

/** Queue an agent run unless the same agent already has one queued for this work item. */
export function enqueueAgentOnce(ctx: AppContext, workItemId: string, agentId: string, payload: Record<string, unknown>) {
  const queued = ctx.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.workItemId, workItemId), eq(jobs.agentId, agentId), eq(jobs.status, "queued")))
    .get();
  if (queued) return null;
  return enqueueJob(ctx, { workItemId, kind: "AGENT_RUN", agentId, payload });
}
