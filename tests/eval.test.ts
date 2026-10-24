import { describe, expect, it } from "vitest";
import { runEvaluation } from "@/server/eval/harness";
import { SEED_CASES, type AnswerKey } from "@/server/sim/cases";
import { setup } from "./helpers";

describe("evaluation harness", () => {
  it("scores every seeded case against its answer key", async () => {
    const { ctx, orchestrator } = setup();
    const report = await runEvaluation(ctx, orchestrator);
    expect(report.cases.filter((c) => !c.correct)).toEqual([]);
    expect(report.metrics.total).toBeGreaterThanOrEqual(25);
    expect(report.metrics.falsePositiveDisputeRate).toBe(0);
    expect(report.metrics.policyAccuracy).toBe(1);
    expect(report.metrics.rejectedCases).toBeGreaterThan(0);
    expect(report.metrics.recoveryRate).toBe(1);
  });

  it("counts disputes the key did not want and fails cases the agents got wrong", async () => {
    const { ctx, orchestrator } = setup();
    const keys: Record<string, AnswerKey> = {
      // Claim the duplicate is legitimate: the agents dispute it first, which is a false positive under this key.
      "D-01b": { outcome: "CHARGE_ALLOCATED", disputeCents: 0, allocation: { "PRJ-INF": 240_000 }, policyId: null },
      // Point a clean line at the wrong project: auto-matching cannot be steered by the controller, so it must fail.
      "C-05": { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-MMP": 480_000 }, policyId: "POL-AUTO-MATCH-v1" },
    };
    const cases = SEED_CASES.map((c) => (keys[c.id] ? { ...c, key: keys[c.id] } : c));
    const report = await runEvaluation(ctx, orchestrator, cases);
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c]));
    expect(byId["D-01b"].disputed).toBe(true);
    expect(byId["D-01b"].rejections).toBe(1);
    expect(report.metrics.falsePositiveDisputes).toBe(1);
    expect(byId["C-05"].correct).toBe(false);
    expect(report.metrics.correct).toBe(report.metrics.total - 1);
  });
});
