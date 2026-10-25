import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AutonomyLevel,
  createSdkMcpServer,
  createSession,
  ReasoningEffort,
  ToolConfirmationOutcome,
  type DroidTool,
} from "@factory/droid-sdk/node";
import type { AppContext } from "../context";
import { getActor } from "../security/actors";
import { recordDenial } from "../security/authorize";
import { ControlError } from "../security/errors";
import { getAgentSettings } from "../settings";
import { invokeTool, RunAbortedError } from "./gateway";
import { buildRunInput, instructionsFor } from "./prompts";
import { runScope, toolsForAgent, type AgentRunContext } from "./tools";

/** The MCP server name Droid sees our gateway tools under. */
export const DROID_SERVER = "moa";
/** Droid's own tools that stay on: Script runs tool calls, ToolSearch loads our tool declarations. Everything else is disabled. */
const DROID_TOOLS_KEPT = new Set(["Script", "ToolSearch"]);
const MAX_TOOL_CALLS = 40;
/** Times Droid is told to finish when a turn ends before a terminal tool succeeded. */
const MAX_NUDGES = 2;

const TOOL_NOTE =
  "\n\nYour tools are on the " + DROID_SERVER + " MCP server, called from Script as tools." + DROID_SERVER + ".<tool_name>(args). " +
  "Call one tool at a time and read its result before the next call. You cannot read files, run commands, or browse; only these tools exist. " +
  "After your terminal tool succeeds, stop and reply with one sentence.";

type Confirmation = { type?: string; serverName?: string; actualToolName?: string; toolName?: string };
type PendingUse = { toolUse?: { name?: string }; details?: Confirmation & { calls?: { toolName?: string; confirmation?: Confirmation }[] } };
export type RequestedCall = { server: string | null; tool: string };

/**
 * The calls inside one Droid permission request, as server and tool names.
 * Droid batches tool calls inside a Script, so one request can hold several.
 */
export function requestedCalls(toolUses: unknown): RequestedCall[] {
  const out: RequestedCall[] = [];
  for (const use of (toolUses as PendingUse[] | undefined) ?? []) {
    const details = use.details;
    if (details?.type === "script") {
      for (const call of details.calls ?? []) {
        const c = call.confirmation;
        if (c?.type === "mcp_tool") out.push({ server: c.serverName ?? null, tool: c.actualToolName ?? c.toolName ?? "" });
        else out.push({ server: null, tool: call.toolName ?? "" });
      }
    } else if (details?.type === "mcp_tool") {
      out.push({ server: details.serverName ?? null, tool: details.actualToolName ?? details.toolName ?? "" });
    } else {
      out.push({ server: null, tool: use.toolUse?.name ?? details?.type ?? "unknown" });
    }
  }
  return out;
}

/** Approve only calls to this employee's gateway tools, plus loading their declarations. */
export function isAllowed(calls: RequestedCall[], allowed: Set<string>) {
  return calls.length > 0 && calls.every((c) => (c.server === DROID_SERVER ? allowed.has(c.tool) : c.server === null && c.tool === "ToolSearch"));
}

function workspace() {
  const dir = path.join(os.tmpdir(), "moa-droid");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run one employee with the Factory Droid SDK. Droid gets only this employee's
 * gateway tools as in-process MCP tools; its built-in tools are disabled, and a
 * permission handler rejects any call outside that list. Every call still goes
 * through invokeTool, so permissions, evidence, and audit match the other modes.
 */
export async function runDroidAgent(ctx: AppContext, run: AgentRunContext) {
  const defs = toolsForAgent(run.agentId, runScope(run));
  const allowed = new Set(defs.map((d) => d.name));
  const actorName = getActor(ctx, run.agentId)?.name ?? run.agentId;
  let stopError: unknown = null;

  const server = createSdkMcpServer({
    name: DROID_SERVER,
    tools: defs.map(
      (def): DroidTool => ({
        name: def.name,
        description: def.description,
        inputSchema: def.schema.shape as unknown as DroidTool["inputSchema"],
        handler: async (input) => {
          if (stopError) return JSON.stringify({ ok: false, error: "Run stopped" });
          try {
            return JSON.stringify(await invokeTool(ctx, run, def.name, input));
          } catch (error) {
            stopError = error;
            return JSON.stringify({ ok: false, error: "Run stopped" });
          }
        },
      }),
    ),
  });

  const session = await createSession({
    cwd: workspace(),
    modelId: ctx.config.droidModel ?? undefined,
    reasoningEffort: ReasoningEffort.Medium,
    autonomyLevel: AutonomyLevel.Off,
    disableBuiltinSkills: true,
    systemPrompt: instructionsFor(run.agentId, getAgentSettings(ctx, run.agentId).guidance, run) + TOOL_NOTE,
    mcpServers: [server],
    permissionHandler: ({ toolUses }) => {
      const calls = requestedCalls(toolUses);
      if (isAllowed(calls, allowed)) return ToolConfirmationOutcome.ProceedOnce;
      const blocked = calls.filter((c) => !(c.server === DROID_SERVER && allowed.has(c.tool))).map((c) => c.tool);
      recordDenial(
        ctx,
        { actorId: run.agentId, action: "droid." + (blocked[0] || "tool"), workItemId: run.workItemId, runId: run.runId, mode: run.mode },
        new ControlError(actorName + " may only use its own tools; Droid asked for " + blocked.join(", "), "DROID_TOOL_SCOPE"),
      );
      return ToolConfirmationOutcome.Cancel;
    },
  });

  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, factoryCredits: 0 };
  try {
    const available = await session.listTools();
    const disabledToolIds = available.map((t) => t.id).filter((id) => !DROID_TOOLS_KEPT.has(id) && !id.startsWith(DROID_SERVER + "___"));
    await session.updateSettings({ disabledToolIds });

    let prompt = buildRunInput(run);
    for (let turn = 0; turn <= MAX_NUDGES && !run.terminal; turn++) {
      for await (const message of session.stream(prompt)) {
        if (ctx.epoch !== run.epoch) stopError ??= new RunAbortedError();
        if (message.type === "result") {
          const t = message.tokenUsage;
          usage.requests += message.turnCount || 1;
          if (t) {
            const input = t.inputTokens + (t.cacheReadTokens ?? 0) + (t.cacheCreationTokens ?? 0);
            usage.inputTokens += input;
            usage.outputTokens += t.outputTokens;
            usage.totalTokens += input + t.outputTokens;
            usage.factoryCredits += t.factoryCredits ?? 0;
          }
          if (!message.success && !message.interrupted && !run.terminal) {
            stopError ??= new Error("Droid run failed: " + (message.error ? JSON.stringify(message.error).slice(0, 300) : message.subtype));
          }
        }
        if (stopError || run.toolCalls > MAX_TOOL_CALLS) break;
      }
      if (stopError) throw stopError;
      if (run.toolCalls > MAX_TOOL_CALLS) throw new Error(actorName + " exceeded " + MAX_TOOL_CALLS + " tool calls");
      prompt = "You have not finished. Your task ends only when your terminal tool succeeds. Continue.";
    }
  } finally {
    await session.close().catch(() => {});
  }
  return usage;
}
