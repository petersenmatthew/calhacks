import { Agent, run as runSdk, setTracingDisabled, tool, type Model } from "@openai/agents";
import type { AppContext } from "../context";
import { getActor } from "../security/actors";
import { getAgentSettings } from "../settings";
import { invokeTool } from "./gateway";
import { buildRunInput, instructionsFor } from "./prompts";
import { runScope, toolsForAgent, type AgentRunContext } from "./tools";

let modelOverride: Model | null = null;

/** Tests inject an SDK ScriptedModel here to drive the real Agents SDK loop. */
export function setModelOverride(model: Model | null) {
  modelOverride = model;
}

if (process.env.OPENAI_AGENTS_DISABLE_TRACING === "1") setTracingDisabled(true);

/**
 * Run one agent with the OpenAI Agents SDK. Every tool call goes through the
 * same gateway as deterministic mode, so permissions and audit are identical.
 * The run ends only after a terminal tool succeeds.
 */
export async function runLlmAgent(ctx: AppContext, run: AgentRunContext) {
  const sdkTools = toolsForAgent(run.agentId, runScope(run)).map((def) =>
    tool({
      name: def.name,
      description: def.description,
      parameters: def.schema,
      strict: true,
      execute: async (args: unknown) => JSON.stringify(await invokeTool(ctx, run, def.name, args)),
    }),
  );
  const agent = new Agent({
    name: getActor(ctx, run.agentId)?.name ?? run.agentId,
    instructions: instructionsFor(run.agentId, getAgentSettings(ctx, run.agentId).guidance, run),
    model: modelOverride ?? ctx.config.model,
    tools: sdkTools,
    modelSettings: { toolChoice: "required", parallelToolCalls: false },
    toolUseBehavior: () =>
      run.terminal
        ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: run.terminal.summary }
        : { isFinalOutput: false, isInterrupted: undefined },
  });
  const result = await runSdk(agent, buildRunInput(run), { maxTurns: 24 });
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const response of result.rawResponses) {
    usage.requests += 1;
    usage.inputTokens += response.usage?.inputTokens ?? 0;
    usage.outputTokens += response.usage?.outputTokens ?? 0;
    usage.totalTokens += response.usage?.totalTokens ?? 0;
  }
  return usage;
}
