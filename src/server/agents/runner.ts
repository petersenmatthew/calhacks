import { eq, sql } from "drizzle-orm";
import { recordActivity } from "../activity";
import { nextId, nowIso, tx, type AppContext } from "../context";
import { agentRuns, workItems } from "../db/schema";
import { ACTOR, getActor } from "../security/actors";
import { agentModelLabel, getExecutionMode } from "../settings";
import { runDroidAgent } from "./droid";
import type { JobRow } from "../workflow/jobs";
import { isOnboarding } from "../workflow/onboarding";
import { getWorkItem, transitionWorkItem } from "../workflow/work-items";
import { runDeterministicAgent } from "./deterministic";
import { RunAbortedError } from "./gateway";
import { runLlmAgent } from "./llm";
import type { AgentRunContext } from "./tools";

/** Model runs started in the last hour, across all sandboxes (public demo cap). */
const llmRuns = ((globalThis as unknown as { __moaLlmRuns?: { starts: number[] } }).__moaLlmRuns ??= { starts: [] });

/**
 * Whether one more live model call fits the public demo's hourly budget (always, elsewhere), counting it if so.
 * Counted across the whole process: every visitor's sandbox shares one model budget.
 */
export function takeLiveModelRun(ctx: AppContext) {
  if (!ctx.config.publicDemo) return true;
  const now = Date.now();
  const recent = llmRuns.starts.filter((t) => now - t < 3_600_000);
  const ok = recent.length < ctx.config.maxLlmRunsPerHour;
  if (ok) recent.push(now);
  llmRuns.starts = recent;
  return ok;
}

export const MAX_AGENT_RUNS_PER_ITEM = 10;

const WORKING_STATES = ["NEW", "INVESTIGATING", "PROPOSED"];

/** Work item states in which each employee may run. */
const ACTIVE_STATES: Record<string, Set<string>> = {
  [ACTOR.compute]: new Set(WORKING_STATES),
  [ACTOR.capacity]: new Set(WORKING_STATES),
  [ACTOR.finance]: new Set(WORKING_STATES),
  [ACTOR.policy]: new Set(WORKING_STATES),
  [ACTOR.vendorLiaison]: new Set(["APPROVED", "DISPUTED"]),
  [ACTOR.budget]: new Set(["APPROVED", "POSTED", "DISPUTED", "RESOLVED"]),
};

function taskFor(agentId: string, trigger: Record<string, unknown>, workItemId: string) {
  const t = String(trigger.trigger ?? "");
  if (t === "onboarding") return "Learn how xAnthropenAI resolves invoice variances from six months of AP history";
  if (t === "dispute_follow_up") return "Follow up with the vendor on the open dispute for " + workItemId;
  if (t === "dispute_escalation") return "Escalate the unanswered vendor dispute on " + workItemId;
  if (agentId === ACTOR.capacity) {
    if (t === "finance_question") return "Answer the Cost Allocator's question on " + workItemId;
    return "Reconstruct reservation usage for " + workItemId;
  }
  if (agentId === ACTOR.policy) {
    return t === "controller_guidance" ? "Check whether the controller's note on " + workItemId + " sets a rule for next time" : "Turn the controller's correction on " + workItemId + " into policy";
  }
  if (agentId === ACTOR.vendorLiaison) {
    if (t === "vendor_reply") return "Read the vendor's reply and close " + workItemId;
    if (t === "vendor_message") return "Handle the vendor's email on " + workItemId;
    if (t === "human_info") return "Answer the vendor on " + workItemId + " with the controller's decision";
    return "Send the approved dispute on " + workItemId;
  }
  if (agentId === ACTOR.budget) return t === "controller_note" ? "Apply the controller's budget change from " + workItemId : "Check team burn after the posting on " + workItemId;
  if (agentId === ACTOR.compute) {
    if (t === "finance_question") return "Answer the Cost Allocator's question on " + workItemId;
    if (t === "human_info") return "Continue the investigation of " + workItemId + " with controller input";
    return "Investigate compute evidence for " + workItemId;
  }
  if (t === "controller_feedback") return "Rework the proposal on " + workItemId + " after controller feedback";
  if (t === "human_info") return "Continue " + workItemId + " with controller input";
  return "Resolve " + workItemId + " from the compute findings";
}

/** Run one agent turn for a work item. Called by the orchestrator. */
export async function runAgentJob(ctx: AppContext, job: JobRow) {
  const agentId = job.agentId;
  if (!agentId) throw new Error("Agent job without agent");
  const onboarding = isOnboarding(job.workItemId);
  const item = onboarding ? null : getWorkItem(ctx, job.workItemId);
  const workItemId = job.workItemId;
  const agentName = getActor(ctx, agentId)?.name ?? agentId;
  // A note the controller left with a decision is read whatever state the case has moved on to.
  const anyState = agentId === ACTOR.policy && job.payload?.trigger === "controller_guidance";
  if (item && !anyState && !(ACTIVE_STATES[agentId] ?? ACTIVE_STATES[ACTOR.finance]).has(item.state)) {
    recordActivity(ctx, {
      workItemId: item.id,
      actorId: ACTOR.orchestrator,
      type: "SYSTEM",
      status: "info",
      title: "Skipped " + agentName + " run; work item is " + item.state,
    });
    return;
  }
  if (item && item.agentRunCount >= MAX_AGENT_RUNS_PER_ITEM) {
    throw new Error("Agent run limit reached for " + item.id);
  }
  let mode = getExecutionMode(ctx);
  // A public demo caps live model runs per hour; past the cap, agents run the scripted replay instead of failing.
  if (mode === "llm" && !takeLiveModelRun(ctx)) mode = "deterministic";
  const runId = nextId(ctx, "RUN", 8001);
  const task = taskFor(agentId, job.payload, workItemId);
  tx(ctx, () => {
    ctx.db
      .insert(agentRuns)
      .values({
        id: runId,
        workItemId,
        agentId,
        mode,
        model: mode === "llm" ? agentModelLabel(ctx) : null,
        task,
        status: "running",
        startedAt: nowIso(),
      })
      .run();
    if (item) {
      ctx.db
        .update(workItems)
        // The Budget Analyst checks in after the fact; it does not take ownership of the work item.
        .set({ agentRunCount: sql`${workItems.agentRunCount} + 1`, ...(agentId === ACTOR.budget ? {} : { assignedAgentId: agentId }) })
        .where(eq(workItems.id, item.id))
        .run();
      if (item.state === "NEW") transitionWorkItem(ctx, item.id, "INVESTIGATING", ACTOR.orchestrator, "Assigned to " + agentName);
    }
    recordActivity(ctx, {
      workItemId,
      runId,
      actorId: agentId,
      type: "AGENT_STARTED",
      status: "info",
      title: agentName + " started: " + task,
      summary:
        mode === "llm"
          ? ctx.config.agentEngine === "droid"
            ? "Factory Droid agent, limited to its own tools (" + agentModelLabel(ctx) + ")"
            : "LLM agent via OpenAI Agents SDK (" + ctx.config.model + ")"
          : "Deterministic replay: scripted agent policy, no LLM calls",
      mode,
    });
  });

  const run: AgentRunContext = {
    runId,
    agentId,
    workItemId,
    mode,
    epoch: ctx.epoch,
    terminal: null,
    toolCalls: 0,
    trigger: job.payload,
  };
  const started = Date.now();
  try {
    let usage: Record<string, number> | null = null;
    if (mode === "llm") usage = ctx.config.agentEngine === "droid" ? await runDroidAgent(ctx, run) : await runLlmAgent(ctx, run);
    else await runDeterministicAgent(ctx, run);
    if (!run.terminal) throw new Error(agentName + " ended without completing its task");
    const terminal = run.terminal;
    tx(ctx, () => {
      ctx.db
        .update(agentRuns)
        .set({ status: "completed", terminalAction: terminal.tool, toolCalls: run.toolCalls, usage, finishedAt: nowIso() })
        .where(eq(agentRuns.id, runId))
        .run();
      recordActivity(ctx, {
        workItemId,
        runId,
        actorId: agentId,
        type: "AGENT_FINISHED",
        status: "ok",
        title: agentName + " finished: " + terminal.summary,
        summary: run.toolCalls + " tool calls in " + ((Date.now() - started) / 1000).toFixed(1) + " s",
        mode,
        durationMs: Date.now() - started,
      });
    });
  } catch (error) {
    if (error instanceof RunAbortedError) {
      try {
        ctx.db.update(agentRuns).set({ status: "cancelled", finishedAt: nowIso() }).where(eq(agentRuns.id, runId)).run();
      } catch {
        /* tables may have been wiped by a reset */
      }
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.db
      .update(agentRuns)
      .set({ status: "failed", error: message, toolCalls: run.toolCalls, finishedAt: nowIso() })
      .where(eq(agentRuns.id, runId))
      .run();
    recordActivity(ctx, {
      workItemId,
      runId,
      actorId: agentId,
      type: "ERROR",
      status: "error",
      title: agentName + " run failed",
      summary: message,
      mode,
    });
    throw error;
  }
}
