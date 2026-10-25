import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { invokeTool } from "@/server/agents/gateway";
import { contracts, findings, proposals, workItems } from "@/server/db/schema";
import { ACTOR } from "@/server/security/actors";
import { setAgentSettings } from "@/server/settings";
import { runScenario } from "@/server/sim/scenarios";
import { buildDisputeEvidence, checkCitedClauses, relevantClauses } from "@/server/workflow/dispute-evidence";
import { setup } from "./helpers";

/** The same Lambda terms, worded and numbered the way another vendor's lawyers might write them. */
const REWORDED = [
  { ref: "A.1", title: "Pricing schedule", text: "8x H100 nodes: USD 100.00 per node-hour." },
  { ref: "B.3", title: "Usage measurement", text: "Usage is counted in whole hours from first boot." },
  { ref: "B.7", title: "End of service", text: "Once a node is decommissioned through the API, no further usage accrues or may be charged." },
  { ref: "F.2", title: "Claims", text: "Customer must notify billing errors within 60 days of the statement date." },
];

async function caseWithRewordedContract() {
  const { ctx, orchestrator } = setup(":memory:");
  await orchestrator.drain();
  setAgentSettings(ctx, ACTOR.controller, ACTOR.finance, { paused: true });
  const ingest = runScenario(ctx, "overbilling");
  const id = ingest.status === "work_item_created" ? ingest.workItemId : "";
  await orchestrator.drain();
  const item = ctx.db.select().from(workItems).where(eq(workItems.id, id)).get()!;
  ctx.db.update(contracts).set({ clauses: REWORDED }).where(eq(contracts.providerId, item.providerId)).run();
  const finding = ctx.db.select().from(findings).where(eq(findings.workItemId, id)).get()!;
  const run = { runId: "RUN-T", agentId: ACTOR.finance, workItemId: id, mode: "deterministic" as const, epoch: ctx.epoch, terminal: null, toolCalls: 0, trigger: {} };
  return { ctx, id, item, run, evidence: [finding.id] };
}

describe("clauses chosen by the Cost Allocator", () => {
  it("keyword matching finds no grounds in a contract worded differently", async () => {
    const { item } = await caseWithRewordedContract();
    if (item.checks.kind !== "instance") throw new Error("expected instance");
    const picked = relevantClauses(REWORDED, item.checks, null).map((c) => c.ref);
    expect(picked).not.toContain("B.7");
  });

  it("accepts the sections the agent picks from the text and puts them in the evidence pack", async () => {
    const { ctx, id, item, run, evidence } = await caseWithRewordedContract();
    const res = await invokeTool(ctx, run, "propose_vendor_dispute", {
      work_item_id: id,
      rationale: "12 h were billed after the node was decommissioned.",
      clauses: [
        { ref: "§ B.7", why: "No usage may be charged after decommissioning; 12 h were billed after it." },
        { ref: "B.3", why: "Hours are counted from first boot, which gives 24 billable hours." },
      ],
      evidence_ids: evidence,
    });
    expect(res).toMatchObject({ ok: true });
    const dispute = ctx.db.select().from(proposals).where(eq(proposals.workItemId, id)).get()!;
    // The claims clause is added for its deadline even though the agent left it out.
    expect(dispute.payload.dispute?.clauseRefs).toEqual(["B.7", "B.3", "F.2"]);
    const pack = buildDisputeEvidence(ctx, ctx.db.select().from(workItems).where(eq(workItems.id, item.id)).get()!);
    expect(pack.clauses.map((c) => c.ref)).toEqual(["B.7", "B.3", "F.2"]);
    expect(pack.clauses[0].why).toMatch(/decommissioning/);
  });

  it("rejects sections that are not in the contract and lists the real ones", async () => {
    const { ctx, id, run, evidence } = await caseWithRewordedContract();
    const res = await invokeTool(ctx, run, "propose_vendor_dispute", {
      work_item_id: id,
      rationale: "Billed after termination.",
      clauses: [{ ref: "4.2", why: "Termination ends billing under the usual Lambda terms." }],
      evidence_ids: evidence,
    });
    expect(res).toMatchObject({ ok: false, rule: "CLAUSE_NOT_FOUND" });
    expect((res as { error: string }).error).toMatch(/B\.7 End of service/);
  });

  it("drops a clause cited without a reason", () => {
    const check = checkCitedClauses(REWORDED, [{ ref: "B.7", why: "" }, { ref: "B.3", why: "Hours are counted from first boot." }], null);
    expect(check.clauses.map((c) => c.ref)).toEqual(["B.3", "F.2"]);
    expect(check.dropped).toEqual([{ ref: "B.7", reason: "No reason given for how it applies." }]);
  });
});
