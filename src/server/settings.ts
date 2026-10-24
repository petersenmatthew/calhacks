import { eq } from "drizzle-orm";
import { recordActivity } from "./activity";
import { appendAudit } from "./audit";
import { notifyChange, type AppContext } from "./context";
import { settings } from "./db/schema";
import { getActor } from "./security/actors";
import { authorize, guard } from "./security/authorize";
import { ControlError } from "./security/errors";

export type ExecutionMode = "llm" | "deterministic";

export function getExecutionMode(ctx: AppContext): ExecutionMode {
  const row = ctx.db.select().from(settings).where(eq(settings.key, "execution_mode")).get();
  const mode = (row?.value as ExecutionMode | undefined) ?? ctx.config.defaultMode;
  if (mode === "llm" && !ctx.config.llmAvailable) return "deterministic";
  return mode;
}

export function setExecutionMode(ctx: AppContext, actorId: string, mode: ExecutionMode) {
  return guard(ctx, { actorId, action: "settings.execution_mode" }, () => {
    authorize(ctx, actorId, "settings:update");
    if (mode === "llm" && !ctx.config.llmAvailable) {
      throw new ControlError("OPENAI_API_KEY is not configured on the server", "CONFIGURATION", "FAILED");
    }
    ctx.db
      .insert(settings)
      .values({ key: "execution_mode", value: mode })
      .onConflictDoUpdate({ target: settings.key, set: { value: mode } })
      .run();
    appendAudit(ctx, { actorId, action: "settings.execution_mode", category: "system", details: { mode } });
    return mode;
  });
}

/** "one": the team finishes each case before starting the next. "all": cases run in parallel. */
export type RunMode = "one" | "all";

export function getRunMode(ctx: AppContext): RunMode {
  const row = ctx.db.select().from(settings).where(eq(settings.key, "run_mode")).get();
  return (row?.value as RunMode | undefined) ?? ctx.config.defaultRunMode;
}

export function setRunMode(ctx: AppContext, actorId: string, mode: RunMode) {
  return guard(ctx, { actorId, action: "settings.run_mode" }, () => {
    authorize(ctx, actorId, "settings:update");
    ctx.db
      .insert(settings)
      .values({ key: "run_mode", value: mode })
      .onConflictDoUpdate({ target: settings.key, set: { value: mode } })
      .run();
    appendAudit(ctx, { actorId, action: "settings.run_mode", category: "system", details: { mode } });
    notifyChange(ctx, "jobs");
    return mode;
  });
}

/** A case to run next in one-at-a-time mode, such as a newly simulated invoice. */
export function getFocusWorkItem(ctx: AppContext): string | null {
  const row = ctx.db.select().from(settings).where(eq(settings.key, "focus_work_item")).get();
  return typeof row?.value === "string" ? row.value : null;
}

export function setFocusWorkItem(ctx: AppContext, workItemId: string) {
  ctx.db
    .insert(settings)
    .values({ key: "focus_work_item", value: workItemId })
    .onConflictDoUpdate({ target: settings.key, set: { value: workItemId } })
    .run();
  notifyChange(ctx, "jobs");
}

/** Per-employee settings the controller can change from the canvas. */
export interface AgentSettings {
  /** Paused employees keep their queued work; nothing new starts until they are resumed. */
  paused: boolean;
  /** Standing guidance appended to the employee's instructions in LLM mode. */
  guidance: string;
}

const agentKey = (agentId: string) => "agent:" + agentId;

export function getAgentSettings(ctx: AppContext, agentId: string): AgentSettings {
  const row = ctx.db.select().from(settings).where(eq(settings.key, agentKey(agentId))).get();
  const v = (row?.value ?? {}) as Partial<AgentSettings>;
  return { paused: Boolean(v.paused), guidance: typeof v.guidance === "string" ? v.guidance : "" };
}

export function pausedAgents(ctx: AppContext): string[] {
  const rows = ctx.sqlite.prepare("SELECT key, value FROM settings WHERE key LIKE 'agent:%'").all() as { key: string; value: string }[];
  return rows.filter((r) => (JSON.parse(r.value) as Partial<AgentSettings>).paused).map((r) => r.key.slice("agent:".length));
}

export function setAgentSettings(ctx: AppContext, actorId: string, agentId: string, patch: Partial<AgentSettings>) {
  return guard(ctx, { actorId, action: "settings.agent", targetType: "actor", targetId: agentId }, () => {
    authorize(ctx, actorId, "settings:update");
    const agent = getActor(ctx, agentId);
    if (!agent || agent.kind !== "agent") throw new ControlError("Unknown agent " + agentId, "NOT_FOUND", "FAILED");
    const before = getAgentSettings(ctx, agentId);
    const next: AgentSettings = {
      paused: patch.paused ?? before.paused,
      guidance: (patch.guidance ?? before.guidance).trim().slice(0, 2000),
    };
    ctx.db
      .insert(settings)
      .values({ key: agentKey(agentId), value: next })
      .onConflictDoUpdate({ target: settings.key, set: { value: next } })
      .run();
    appendAudit(ctx, { actorId, action: "settings.agent", category: "system", targetType: "actor", targetId: agentId, details: { before, after: next } });
    const changes: string[] = [];
    if (next.paused !== before.paused) changes.push(next.paused ? "Paused" : "Resumed");
    if (next.guidance !== before.guidance) changes.push("Guidance updated");
    if (changes.length) {
      recordActivity(ctx, {
        actorId,
        type: "SYSTEM",
        status: "info",
        title: changes.join(", ") + ": " + agent.name,
        changes,
      });
    }
    // Resuming lets the worker pick up anything that waited.
    notifyChange(ctx, "jobs");
    return next;
  });
}
