import { recordActivity } from "./activity";
import type { AppContext } from "./context";
import { RunAbortedError } from "./agents/gateway";
import { runAgentJob } from "./agents/runner";
import { runScheduledWork } from "./scheduler";
import { dispatchOutbox, recoverOutbox } from "./comms/dispatch";
import { ACTOR, getActor } from "./security/actors";
import { guard } from "./security/authorize";
import { executeDecision } from "./workflow/decisions";
import { claimNextJob, finishJob, recoverInterruptedJobs, type JobRow } from "./workflow/jobs";
import { getWorkItem, transitionWorkItem } from "./workflow/work-items";
import { eq } from "drizzle-orm";
import { workItems } from "./db/schema";

const MAX_ATTEMPTS = 2;

export async function executeJob(ctx: AppContext, job: JobRow) {
  if (job.kind === "AGENT_RUN") return runAgentJob(ctx, job);
  if (job.kind === "EXECUTE_DECISION") return executeDecision(ctx, String(job.payload.approvalId));
  throw new Error("Unknown job kind " + job.kind);
}

function escalate(ctx: AppContext, job: JobRow, message: string) {
  try {
    guard(ctx, { actorId: ACTOR.orchestrator, action: "workflow.escalate", workItemId: job.workItemId }, () => {
      const item = getWorkItem(ctx, job.workItemId);
      if (!["NEW", "INVESTIGATING", "PROPOSED"].includes(item.state)) return;
      const agentId = job.agentId ?? ACTOR.compute;
      transitionWorkItem(ctx, item.id, "NEEDS_INFO", ACTOR.orchestrator, "Escalated after repeated failure");
      ctx.db
        .update(workItems)
        .set({
          pendingQuestion: {
            agentId,
            askedBy: ACTOR.orchestrator,
            question:
              (getActor(ctx, agentId)?.name ?? "The agent") + " could not finish (" + message.slice(0, 200) +
              "). Add guidance and resume, or switch to deterministic replay.",
          },
        })
        .where(eq(workItems.id, item.id))
        .run();
    });
  } catch {
    /* escalation is best effort */
  }
}

/**
 * Durable worker. Jobs live in SQLite, so queued and interrupted work resumes
 * after a restart. Different work items run concurrently; each work item runs
 * one job at a time.
 */
export class Orchestrator {
  private timer: NodeJS.Timeout | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private scheduling = false;
  private active = new Set<Promise<void>>();
  private paused = false;
  private dispatching = false;
  private readonly onChange = (topic: string) => {
    if (topic === "jobs") this.tick();
    if (topic === "outbox" && this.timer) void this.deliver();
  };

  /** Send newly queued email and Slack messages right away instead of waiting for the next schedule tick. */
  private async deliver() {
    if (this.dispatching || this.paused) return;
    this.dispatching = true;
    try {
      await dispatchOutbox(this.ctx);
    } catch {
      /* retried on the next schedule tick */
    } finally {
      this.dispatching = false;
    }
  }

  constructor(private ctx: AppContext, private concurrency = 3) {}

  start() {
    if (this.timer) return;
    recoverOutbox(this.ctx);
    const recovered = recoverInterruptedJobs(this.ctx);
    if (recovered > 0) {
      recordActivity(this.ctx, {
        actorId: ACTOR.orchestrator,
        type: "SYSTEM",
        status: "info",
        title: "Recovered " + recovered + " interrupted job(s) after restart",
      });
    }
    this.timer = setInterval(() => this.tick(), 400);
    if (this.ctx.config.schedulerIntervalMs > 0) {
      this.scheduleTimer = setInterval(() => void this.runSchedule(), this.ctx.config.schedulerIntervalMs);
      setTimeout(() => void this.runSchedule(), 1500);
    }
    this.ctx.bus.on("change", this.onChange);
    this.tick();
  }

  /** Feed sync and time-based follow-ups. Skipped while paused (demo reset) or already running. */
  async runSchedule() {
    if (this.paused || this.scheduling) return;
    this.scheduling = true;
    try {
      await runScheduledWork(this.ctx, { feedUrl: this.ctx.config.feedUrl });
      this.tick();
    } finally {
      this.scheduling = false;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.scheduleTimer = null;
    this.timer = null;
    this.ctx.bus.off("change", this.onChange);
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.tick();
  }

  get activeCount() {
    return this.active.size;
  }

  async waitForIdle(timeoutMs = 15_000) {
    const until = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < until) await Promise.race([...this.active]);
  }

  private tick() {
    if (this.paused) return;
    while (this.active.size < this.concurrency) {
      const job = claimNextJob(this.ctx);
      if (!job) break;
      const promise: Promise<void> = this.process(job).finally(() => {
        this.active.delete(promise);
        setImmediate(() => this.tick());
      });
      this.active.add(promise);
    }
  }

  async process(job: JobRow) {
    const epoch = this.ctx.epoch;
    try {
      await executeJob(this.ctx, job);
      if (epoch === this.ctx.epoch) finishJob(this.ctx, job.id, "done");
    } catch (error) {
      if (error instanceof RunAbortedError || epoch !== this.ctx.epoch) return;
      const message = error instanceof Error ? error.message : String(error);
      if (job.attempts < MAX_ATTEMPTS && job.kind === "AGENT_RUN") {
        finishJob(this.ctx, job.id, "queued", message);
      } else {
        finishJob(this.ctx, job.id, "failed", message);
        escalate(this.ctx, job, message);
      }
    }
  }

  /** Process queued jobs sequentially until none remain (tests, seeding). */
  async drain(limit = 500) {
    for (let i = 0; i < limit; i += 1) {
      const job = claimNextJob(this.ctx);
      if (!job) return;
      await this.process(job);
    }
    throw new Error("drain limit reached");
  }
}
