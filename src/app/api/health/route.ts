import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

/** Liveness for the hosting platform: the database answers and the worker is up. */
export function GET() {
  try {
    const { ctx, orchestrator } = getRuntime();
    ctx.sqlite.prepare("SELECT 1").get();
    return Response.json({ ok: true, activeJobs: orchestrator.activeCount, scheduler: ctx.config.schedulerIntervalMs > 0 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
