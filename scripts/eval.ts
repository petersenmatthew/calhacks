import { createAppContext } from "@/server/context";
import { Orchestrator } from "@/server/orchestrator";
import { seedEnvironment } from "@/server/sim/seed";
import { formatReport, runEvaluation } from "@/server/eval/harness";

/*
 * npm run eval            deterministic agents (no API key needed)
 * AGENT_MODE=llm npm run eval   LLM agents (needs OPENAI_API_KEY)
 * Uses an in-memory database; the app's data/ database is not touched.
 */
async function main() {
  const mode = process.env.AGENT_MODE === "llm" ? "llm" : "deterministic";
  const ctx = createAppContext({
    file: ":memory:",
    config: { stepDelayMs: 0, llmAvailable: mode === "llm", defaultMode: mode, model: process.env.OPENAI_MODEL },
  });
  seedEnvironment(ctx);
  const report = await runEvaluation(ctx, new Orchestrator(ctx));
  console.log("Agent mode: " + mode + "\n");
  console.log(formatReport(report));
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.metrics.correct === report.metrics.total ? 0 : 1;
}

main();
