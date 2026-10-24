import { z } from "zod";
import { runEval, type EvalReport } from "@/server/eval/run";
import { errorResponse } from "@/server/http";
import { getContext } from "@/server/runtime";

export const dynamic = "force-dynamic";

const cache = globalThis as unknown as { __evalReports?: Partial<Record<"deterministic" | "llm", EvalReport>>; __evalRunning?: boolean };

export function GET() {
  return Response.json({ reports: cache.__evalReports ?? {}, running: Boolean(cache.__evalRunning), llmAvailable: getContext().config.llmAvailable });
}

const body = z.object({ mode: z.enum(["deterministic", "llm"]).default("deterministic") });

/** Run the answer key in isolated in-memory sandboxes. The live database is not touched. */
export async function POST(request: Request) {
  try {
    const { mode } = body.parse(await request.json().catch(() => ({})));
    const ctx = getContext();
    if (mode === "llm" && !ctx.config.llmAvailable) throw new Error("OPENAI_API_KEY is not configured on the server");
    if (cache.__evalRunning) throw new Error("An evaluation is already running");
    cache.__evalRunning = true;
    try {
      const report = await runEval({ mode, model: mode === "llm" ? ctx.config.model : undefined });
      cache.__evalReports = { ...(cache.__evalReports ?? {}), [mode]: report };
      return Response.json(report);
    } finally {
      cache.__evalRunning = false;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
