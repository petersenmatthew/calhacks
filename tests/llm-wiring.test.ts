import { setTracingDisabled } from "@openai/agents";
import { functionCall, modelResponder, ScriptedModel } from "@openai/agents/testing";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { activityEvents, agentRuns, evidence, findings, jobs } from "@/server/db/schema";
import { setModelOverride } from "@/server/agents/llm";
import { runScenario } from "@/server/sim/scenarios";
import { claimNextJob } from "@/server/workflow/jobs";
import { setup, workItem } from "./helpers";

setTracingDisabled(true);
afterAll(() => setModelOverride(null));

describe("OpenAI Agents SDK wiring", () => {
  it("runs the GPU Auditor through the SDK loop, the gateway, and its guardrails", async () => {
    const { ctx, orchestrator } = setup(":memory:", { llmAvailable: true, defaultMode: "llm" });
    ctx.db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.status, "queued")).run();
    const ingest = runScenario(ctx, "overbilling");
    const id = ingest.status === "work_item_created" ? ingest.workItemId : "";
    const item = workItem(ctx, id);
    const evidenceIds = () =>
      ctx.db.select({ id: evidence.id }).from(evidence).where(eq(evidence.workItemId, id)).all().map((e) => e.id);

    const findingArgs = (assessment: string) => ({
      work_item_id: id,
      summary: "Instance ran 24 h; invoice bills 36 h. Provider meter ran 12 h past termination.",
      charge_assessment: assessment,
      owner_project_id: "PRJ-FLM",
      anomalies: [{ code: "METER_AFTER_TERMINATION", description: "Meter ran past TERMINATED" }],
      clause_refs: ["4.2"],
      evidence_ids: evidenceIds(),
    });
    const plan: (() => { name: string; args: Record<string, unknown> })[] = [
      () => ({ name: "get_work_item", args: { work_item_id: id } }),
      () => ({ name: "get_instance_lifecycle", args: { instance_id: item.instanceId } }),
      () => ({ name: "get_provider_usage", args: { instance_id: item.instanceId } }),
      () => ({ name: "get_billing_terms", args: { provider_id: "PRV-HELIOS" } }),
      // The model first makes a wrong claim; the gateway rejects it with ok:false.
      () => ({ name: "submit_compute_findings", args: findingArgs("explained") }),
      () => ({ name: "submit_compute_findings", args: findingArgs("not_explained") }),
      () => ({ name: "handoff_to_finance", args: { work_item_id: id, note: "Recommend dispute." } }),
    ];
    const model = new ScriptedModel(
      plan.map((step, i) =>
        modelResponder(() => {
          const s = step();
          return [functionCall(s.name, s.args, { callId: "call_" + i })];
        }),
      ),
    );
    setModelOverride(model);

    const job = claimNextJob(ctx);
    expect(job?.agentId).toBe("agent.compute");
    await orchestrator.process(job!);
    model.assertComplete();

    const run = ctx.db.select().from(agentRuns).where(eq(agentRuns.workItemId, id)).get();
    expect(run?.mode).toBe("llm");
    expect(run?.status).toBe("completed");
    expect(run?.terminalAction).toBe("handoff_to_finance");
    const rejected = ctx.db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.workItemId, id), eq(activityEvents.type, "ERROR")))
      .all();
    expect(rejected.some((e) => (e.summary ?? "").includes("ARITHMETIC_CHECK"))).toBe(true);
    const stored = ctx.db.select().from(findings).where(eq(findings.workItemId, id)).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].assessment).toBe("not_explained");
    expect(workItem(ctx, id).assignedAgentId).toBe("agent.finance");
  });
});
