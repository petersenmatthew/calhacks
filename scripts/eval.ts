import fs from "node:fs";
import path from "node:path";
import { reportMarkdown, runEval } from "../src/server/eval/run";

/*
 * npm run eval            deterministic replay
 * npm run eval -- --llm   LLM agents (needs OPENAI_API_KEY)
 */
async function main() {
  const llm = process.argv.includes("--llm");
  if (llm && !process.env.OPENAI_API_KEY) throw new Error("Set OPENAI_API_KEY to evaluate LLM agents.");
  const report = await runEval({ mode: llm ? "llm" : "deterministic", model: process.env.OPENAI_MODEL });
  const md = reportMarkdown(report);
  const out = path.join(process.cwd(), "docs", llm ? "eval-report-llm.md" : "eval-report.md");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);
  for (const c of report.cases) console.log((c.pass ? "PASS " : "FAIL ") + c.id.padEnd(26) + c.observed);
  console.log("\nAccuracy " + report.passed + "/" + report.total + ". Report written to " + path.relative(process.cwd(), out));
  if (report.passed !== report.total) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
