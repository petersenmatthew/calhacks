import { and, asc, eq, notInArray } from "drizzle-orm";
import { notifyChange, nowIso, txImmediate, type AppContext } from "../context";
import { jobs } from "../db/schema";

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

/** Claim the oldest queued job whose work item has no running job. */
export function claimNextJob(ctx: AppContext): JobRow | null {
  return txImmediate(ctx, () => {
    const busyWorkItems = ctx.db.select({ id: jobs.workItemId }).from(jobs).where(eq(jobs.status, "running"));
    const candidate = ctx.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "queued"), notInArray(jobs.workItemId, busyWorkItems)))
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
