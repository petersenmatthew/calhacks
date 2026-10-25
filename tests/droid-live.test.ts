import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { activityEvents, agentRuns, jobs } from "@/server/db/schema";
import { runScenario } from "@/server/sim/scenarios";
import { claimNextJob } from "@/server/workflow/jobs";
import { setup, workItem } from "./helpers";

// Live check against Factory: DROID_LIVE=1 npx vitest run tests/droid-live.test.ts (needs FACTORY_API_KEY and the droid CLI).
describe.skipIf(!process.env.DROID_LIVE || !process.env.FACTORY_API_KEY)("Factory Droid engine (live)", () => {
  it("works the overbilling case through the gateway until it needs the controller", { timeout: 600_000 }, async () => {
    const { ctx, orchestrator } = setup(":memory:", { defaultMode: "llm", agentEngine: "droid", droidModel: process.env.DROID_MODEL || null });
    ctx.db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.status, "queued")).run();
    const ingest = runScenario(ctx, "overbilling");
    const id = ingest.status === "work_item_created" ? ingest.workItemId : "";

    for (let i = 0; i < 8; i++) {
      const job = claimNextJob(ctx);
      if (!job) break;
      await orchestrator.process(job);
    }

    const runs = ctx.db.select().from(agentRuns).where(eq(agentRuns.workItemId, id)).all();
    const events = ctx.db.select().from(activityEvents).where(eq(activityEvents.workItemId, id)).all();
    console.log(runs.map((r) => [r.agentId, r.status, r.model, r.toolCalls, JSON.stringify(r.usage)].join(" | ")).join("\n"));
    console.log(events.map((e) => e.type + ": " + e.title).join("\n"));
    console.log("state:", workItem(ctx, id).state);

    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.status === "completed" && r.model?.startsWith("droid/"))).toBe(true);
  });
});
