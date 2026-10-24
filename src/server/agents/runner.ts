import { eq, sql } from "drizzle-orm";
import { recordActivity } from "../activity";
import { nextId, nowIso, tx, type AppContext } from "../context";
import { agentRuns, workItems } from "../db/schema";
import { ACTOR, getActor } from "../security/actors";
import { getExecutionMode } from "../settings";
import type { JobRow } from "../workflow/jobs";
import { getWorkItem, transitionWorkItem } from "../workflow/work-items";
import { runDeterministicAgent } from "./deterministic";
import { RunAbortedError } from "./gateway";
import { runLlmAgent } from "./llm";
import type { AgentRunContext } from "./tools";

export const MAX_AGENT_RUNS_PER_ITEM = 10;

const ACTIVE_STATES = new Set(["NEW", "INVESTIGATING", "PROPOSED"]);

function taskFor(agentId: string, trigger: Record<string, unknown>, workItemId: string) {
  const t = String(trigger.trigger ?? "");
  if (agentId === ACTOR.compute) {
    if (t === "finance_question") return "Answer the Finance Agent's question on " + workItemId;
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
  const item = getWorkItem(ctx, job.workItemId);
  const agentName = getActor(ctx, agentId)?.name ?? agentId;
  if (!ACTIVE_STATES.has(item.state)) {
    recordActivity(ctx, {
      workItemId: item.id,
      actorId: ACTOR.orchestrator,
      type: "SYSTEM",
      status: "info",
      title: "Skipped " + agentName + " run; work item is " + item.state,
    });
    return;
  }
  if (item.agentRunCount >= MAX_AGENT_RUNS_PER_ITEM) {
    throw new Error("Agent run limit reached for " + item.id);
  }
  const mode = getExecutionMode(ctx);
  const runId = nextId(ctx, "RUN", 8001);
  const task = taskFor(agentId, job.payload, item.id);
  tx(ctx, () => {
    ctx.db
      .insert(agentRuns)
      .values({
        id: runId,
        workItemId: item.id,
        agentId,
        mode,
        model: mode === "llm" ? ctx.config.model : null,
        task,
        status: "running",
        startedAt: nowIso(),
      })
      .run();
    ctx.db
      .update(workItems)
      .set({ agentRunCount: sql`${workItems.agentRunCount} + 1`, assignedAgentId: agentId })
      .where(eq(workItems.id, item.id))
      .run();
    if (item.state === "NEW") transitionWorkItem(ctx, item.id, "INVESTIGATING", ACTOR.orchestrator, "Assigned to " + agentName);
    recordActivity(ctx, {
      workItemId: item.id,
      runId,
      actorId: agentId,
      type: "AGENT_STARTED",
      status: "info",
      title: agentName + " started: " + task,
      summary:
        mode === "llm"
          ? "LLM agent via OpenAI Agents SDK (" + ctx.config.model + ")"
          : "Deterministic replay: scripted agent policy, no LLM calls",
      mode,
    });
  });

  const run: AgentRunContext = {
    runId,
    agentId,
    workItemId: item.id,
    mode,
    epoch: ctx.epoch,
    terminal: null,
    toolCalls: 0,
    trigger: job.payload,
  };
  const started = Date.now();
  try {
    let usage: Record<string, number> | null = null;
    if (mode === "llm") usage = await runLlmAgent(ctx, run);
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
        workItemId: item.id,
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
      workItemId: item.id,
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
