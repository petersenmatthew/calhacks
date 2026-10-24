import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { approvalRequests, projects, vendorDisputes } from "@/server/db/schema";
import { ACTOR } from "@/server/security/actors";
import { runScenario } from "@/server/sim/scenarios";
import { decideApproval } from "@/server/workflow/approvals";
import { pendingApprovals, setup } from "./helpers";

async function pendingDispute() {
  const { ctx, orchestrator } = setup(":memory:");
  await orchestrator.drain();
  const ingest = runScenario(ctx, "overbilling");
  const id = ingest.status === "work_item_created" ? ingest.workItemId : "";
  await orchestrator.drain();
  return { ctx, orchestrator, id, approvalId: pendingApprovals(ctx, id)[0].id };
}

const budgetOf = (ctx: ReturnType<typeof setup>["ctx"], projectId: string) =>
  ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()!.monthlyBudgetCents;

describe("yes, but", () => {
  it("approves the dispute, keeps the note, and changes the budget the controller named", async () => {
    const { ctx, orchestrator, id, approvalId } = await pendingDispute();
    decideApproval(ctx, {
      approvalId,
      actorId: ACTOR.controller,
      decision: "APPROVED",
      reason: "Also lower the Multimodal Perception budget to $200,000.",
      budget: { projectId: "PRJ-MMP", monthlyCents: 20_000_000 },
    });
    await orchestrator.drain();
    expect(ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, id)).get()?.status).toBe("SUBMITTED");
    expect(ctx.db.select().from(approvalRequests).where(eq(approvalRequests.id, approvalId)).get()?.decisionReason).toContain("Multimodal");
    expect(budgetOf(ctx, "PRJ-MMP")).toBe(20_000_000);
  });

  it("refuses a budget change that does not come with an approval", async () => {
    const { ctx, approvalId } = await pendingDispute();
    expect(() =>
      decideApproval(ctx, {
        approvalId,
        actorId: ACTOR.controller,
        decision: "REJECTED",
        reason: "Pay it in full.",
        budget: { projectId: "PRJ-MMP", monthlyCents: 20_000_000 },
      }),
    ).toThrow(/budget change/);
    expect(budgetOf(ctx, "PRJ-MMP")).toBe(24_000_000);
    expect(ctx.db.select().from(approvalRequests).where(eq(approvalRequests.id, approvalId)).get()?.status).toBe("PENDING");
  });
});
