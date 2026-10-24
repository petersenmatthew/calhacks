import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { collectActivity, recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { nextId, nowIso, sleep, type AppContext } from "../context";
import { evidence } from "../db/schema";
import { getActor } from "../security/actors";
import { authorize, guard, recordDenial } from "../security/authorize";
import { ControlError, isControlError } from "../security/errors";
import { getWorkItem } from "../workflow/work-items";
import { TOOL_INDEX, toolsForAgent, type AgentRunContext, type ToolEvidence } from "./tools";

export class RunAbortedError extends Error {
  constructor(message = "Environment was reset") {
    super(message);
    this.name = "RunAbortedError";
  }
}

export type ToolResponse = { ok: boolean; error?: string; rule?: string; [key: string]: unknown };

function upsertEvidence(ctx: AppContext, run: AgentRunContext, workItemId: string, ev: ToolEvidence) {
  const existing = ctx.db
    .select({ id: evidence.id, label: evidence.label })
    .from(evidence)
    .where(and(eq(evidence.workItemId, workItemId), eq(evidence.sourceType, ev.sourceType), eq(evidence.sourceId, ev.sourceId)))
    .get();
  if (existing) return existing;
  const id = nextId(ctx, "EV", 4001);
  ctx.db
    .insert(evidence)
    .values({
      id,
      workItemId,
      sourceType: ev.sourceType,
      sourceId: ev.sourceId,
      label: ev.label,
      snapshot: JSON.parse(JSON.stringify(ev.snapshot ?? null)),
      collectedBy: run.agentId,
      runId: run.runId,
      createdAt: nowIso(),
    })
    .run();
  return { id, label: ev.label };
}

/**
 * The single path from an agent (LLM or deterministic) to the system.
 * Enforces permissions, argument validation, work-item scope, and records
 * evidence, activity, and audit for every call, including denied ones.
 */
export async function invokeTool(ctx: AppContext, run: AgentRunContext, name: string, rawArgs: unknown): Promise<ToolResponse> {
  if (ctx.epoch !== run.epoch) throw new RunAbortedError();
  if (run.mode === "deterministic" && ctx.config.stepDelayMs > 0) {
    await sleep(ctx.config.stepDelayMs);
    if (ctx.epoch !== run.epoch) throw new RunAbortedError();
  }
  run.toolCalls += 1;
  const started = Date.now();
  const meta = {
    actorId: run.agentId,
    action: "tool:" + name,
    workItemId: run.workItemId,
    targetType: "tool",
    targetId: name,
    runId: run.runId,
    mode: run.mode,
  };
  const def = TOOL_INDEX.get(name);
  const allowedForAgent = toolsForAgent(run.agentId).some((t) => t.name === name);
  if (!def || !allowedForAgent) {
    const error = new ControlError(
      (getActor(ctx, run.agentId)?.name ?? run.agentId) + " has no tool named " + name,
      def ? "RBAC" : "UNKNOWN_TOOL",
    );
    recordDenial(ctx, meta, error);
    return { ok: false, error: error.message, rule: error.rule };
  }
  const parsed = def.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const error = new ControlError("Invalid arguments for " + name + ": " + z.prettifyError(parsed.error), "INVALID_INPUT", "FAILED");
    recordDenial(ctx, meta, error);
    return { ok: false, error: error.message, rule: error.rule };
  }
  const args = parsed.data as Record<string, unknown>;
  try {
    return guard(ctx, meta, () => {
      authorize(ctx, run.agentId, def.permission);
      if (typeof args.work_item_id === "string" && args.work_item_id !== run.workItemId) {
        throw new ControlError("Agents may only act on their assigned work item (" + run.workItemId + ")", "SCOPE");
      }
      const item = getWorkItem(ctx, run.workItemId);
      const { value: out, events: sideEffects } = collectActivity(ctx, () => def.handler({ ctx, run, item }, args));
      const refs = (out.evidence ?? []).map((ev) => upsertEvidence(ctx, run, item.id, ev));
      const cited = Array.isArray(args.evidence_ids) ? (args.evidence_ids as string[]) : [];
      const evidenceIds = [...new Set([...refs.map((r) => r.id), ...cited])];
      const response: ToolResponse = { ok: true, ...out.result, evidence: refs.map((r) => ({ id: r.id, label: r.label })) };
      recordActivity(ctx, {
        workItemId: item.id,
        runId: run.runId,
        actorId: run.agentId,
        type: out.activityType ?? "TOOL_CALL",
        title: out.title,
        summary: out.summary ?? null,
        toolName: name,
        args,
        result: response,
        evidenceIds,
        changes: out.changes ?? [],
        mode: run.mode,
        durationMs: Date.now() - started,
      });
      for (const event of sideEffects) recordActivity(ctx, { ...event, runId: event.runId ?? run.runId });
      appendAudit(ctx, {
        actorId: run.agentId,
        action: "tool:" + name,
        category: def.category,
        targetType: "work_item",
        targetId: item.id,
        workItemId: item.id,
        evidenceIds,
        details: { runId: run.runId, mode: run.mode, args },
      });
      if (out.terminal) run.terminal = { tool: name, summary: out.terminal.summary };
      return response;
    });
  } catch (error) {
    if (isControlError(error)) return { ok: false, error: error.message, rule: error.rule };
    if (error instanceof RunAbortedError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    recordActivity(ctx, {
      workItemId: run.workItemId,
      runId: run.runId,
      actorId: run.agentId,
      type: "ERROR",
      status: "error",
      title: "Tool " + name + " failed",
      summary: message,
      toolName: name,
      args,
      mode: run.mode,
    });
    appendAudit(ctx, {
      actorId: run.agentId,
      action: "tool:" + name,
      outcome: "FAILED",
      category: def.category,
      workItemId: run.workItemId,
      details: { error: message },
    });
    return { ok: false, error: "Tool failed: " + message };
  }
}
