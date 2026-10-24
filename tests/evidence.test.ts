import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { invokeTool } from "@/server/agents/gateway";
import { findings, proposals } from "@/server/db/schema";
import { ACTOR } from "@/server/security/actors";
import { setAgentSettings } from "@/server/settings";
import { runScenario } from "@/server/sim/scenarios";
import { setup } from "./helpers";

describe("evidence citations", () => {
  it("accepts a finding id as a citation and records the finding's evidence", async () => {
    const { ctx, orchestrator } = setup(":memory:");
    await orchestrator.drain();
    // Stop after the Compute Investigator hands off, so the Cost Accountant's call is ours.
    setAgentSettings(ctx, ACTOR.controller, ACTOR.finance, { paused: true });
    const ingest = runScenario(ctx, "overbilling");
    const id = ingest.status === "work_item_created" ? ingest.workItemId : "";
    await orchestrator.drain();
    const finding = ctx.db.select().from(findings).where(eq(findings.workItemId, id)).get()!;

    const run = { runId: "RUN-T", agentId: ACTOR.finance, workItemId: id, mode: "deterministic" as const, epoch: ctx.epoch, terminal: null, toolCalls: 0, trigger: {} };
    const res = await invokeTool(ctx, run, "propose_vendor_dispute", {
      work_item_id: id,
      rationale: "Lifecycle and contract support 24 h; 12 h were billed after termination.",
      clause_refs: ["4.2"],
      evidence_ids: [finding.id],
    });

    expect(res).toMatchObject({ ok: true });
    const dispute = ctx.db.select().from(proposals).where(eq(proposals.workItemId, id)).get()!;
    expect(dispute.evidenceIds).toEqual(finding.evidenceIds);
  });
});
