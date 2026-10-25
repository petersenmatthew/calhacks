import { createAppContext } from "@/server/context";
import { Orchestrator } from "@/server/orchestrator";
import { seedEnvironment } from "@/server/sim/seed";
import { formatReport, runEvaluation } from "@/server/eval/harness";
import { SEED_CASES } from "@/server/sim/cases";

/*
 * npm run eval            deterministic agents (no API key needed)
 * AGENT_MODE=llm npm run eval   LLM agents (needs OPENAI_API_KEY)
 * npm run eval:live       two cases on the live model, key from .env.local
 * --case=O-01,E-01        only these cases (ids from src/server/sim/cases.ts)
 * Uses an in-memory database; the app's data/ database is not touched.
 */
async function main() {
  const mode = process.env.AGENT_MODE === "llm" ? "llm" : "deterministic";
  const ctx = createAppContext({
    file: ":memory:",
    config: { stepDelayMs: 0, llmAvailable: mode === "llm", defaultMode: mode, model: process.env.OPENAI_MODEL },
  });
  const only = process.argv.find((a) => a.startsWith("--case="))?.slice("--case=".length).split(",").filter(Boolean);
  const unknown = only?.filter((id) => !SEED_CASES.some((c) => c.id === id)) ?? [];
  if (unknown.length) throw new Error("Unknown case id: " + unknown.join(", "));
  seedEnvironment(ctx, only ?? "all");
  const report = await runEvaluation(ctx, new Orchestrator(ctx), only ? SEED_CASES.filter((c) => only.includes(c.id)) : SEED_CASES);
  console.log("Agent mode: " + mode + "\n");
  console.log(formatReport(report));
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.metrics.correct === report.metrics.total ? 0 : 1;
}

main();
