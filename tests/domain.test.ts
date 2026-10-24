import { describe, expect, it } from "vitest";
import { allocateReservation, assessPolicyFit } from "@/server/domain/allocation";
import { contractBillableHours, unionHours } from "@/server/domain/billing";
import { splitByWeights } from "@/server/domain/money";

describe("financial arithmetic", () => {
  it("splits awkward weights so parts sum exactly to the total", () => {
    const parts = splitByWeights(100_001, [
      { key: "a", weight: 1 },
      { key: "b", weight: 1 },
      { key: "c", weight: 1 },
    ]);
    expect([...parts.values()].reduce((s, v) => s + v, 0)).toBe(100_001);
  });

  it("allocates the shared reservation both ways and always sums to $12,400", () => {
    const usage = {
      totalCents: 1_240_000,
      ownerProjectId: "PRJ-FLM",
      usageByProject: [
        { projectId: "PRJ-FLM", gpuHours: 1116 },
        { projectId: "PRJ-MMP", gpuHours: 868 },
      ],
      idleGpuHours: 496,
    };
    const byUsage = Object.fromEntries(allocateReservation("usage_proportional", usage).map((l) => [l.projectId, l.amountCents]));
    const ownerIdle = Object.fromEntries(allocateReservation("owner_pays_idle", usage).map((l) => [l.projectId, l.amountCents]));
    expect(byUsage).toEqual({ "PRJ-FLM": 697_500, "PRJ-MMP": 542_500 });
    expect(ownerIdle).toEqual({ "PRJ-FLM": 806_000, "PRJ-MMP": 434_000 });
  });

  it("bills the instance lifetime, not the training job", () => {
    const terms = { billingIncrementHours: 1, minimumHours: 1 };
    expect(contractBillableHours(24, terms)).toBe(24);
    expect(contractBillableHours(23.2, terms)).toBe(24);
    expect(contractBillableHours(5.2, { billingIncrementHours: 1, minimumHours: 8 })).toBe(8);
    expect(
      unionHours([
        { start: "2026-10-01T00:00:00Z", end: "2026-10-01T10:00:00Z" },
        { start: "2026-10-01T05:00:00Z", end: "2026-10-01T12:00:00Z" },
      ]),
    ).toBe(12);
  });

  it("flags a conflict between usage-based policy and owner-accountable reservation terms", () => {
    const policy = { id: "POL-ALLOC-SHARED-v1", version: 1, rule: { method: "usage_proportional" } };
    expect(assessPolicyFit(policy, { id: "RSV-2210", ownerAccountableForIdle: true }).consistent).toBe(false);
    expect(assessPolicyFit(policy, { id: "RSV-1960", ownerAccountableForIdle: false }).consistent).toBe(true);
  });
});
