import { describe, expect, it } from "vitest";
import { runEval } from "@/server/eval/run";

describe("answer key", () => {
  it("deterministic replay matches every hand-computed outcome", async () => {
    const report = await runEval();
    const failed = report.cases.filter((c) => !c.pass).map((c) => c.id + ": " + c.observed);
    expect(failed).toEqual([]);
    expect(report.overcharges.caught).toBe(report.overcharges.planted);
    expect(report.falseDisputes).toBe(0);
  }, 60_000);
});
