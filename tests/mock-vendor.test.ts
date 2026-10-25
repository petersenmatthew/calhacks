import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vendorDisputes, vendorMessages } from "@/server/db/schema";
import { ACTOR } from "@/server/security/actors";
import { runScenario } from "@/server/sim/scenarios";
import { decideApproval } from "@/server/workflow/approvals";
import { mockVendorEnabled, runMockVendor } from "@/server/workflow/mock-vendor";
import { pendingApprovals, setup } from "./helpers";

async function openDispute() {
  const { ctx, orchestrator } = setup(":memory:");
  await orchestrator.drain();
  const ingest = runScenario(ctx, "overbilling");
  const id = ingest.status === "work_item_created" ? ingest.workItemId : "";
  await orchestrator.drain();
  decideApproval(ctx, { approvalId: pendingApprovals(ctx, id)[0].id, actorId: ACTOR.controller, decision: "APPROVED" });
  await orchestrator.drain();
  return { ctx, orchestrator, id };
}

const disputeOf = (ctx: ReturnType<typeof setup>["ctx"], id: string) => ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, id)).get()!;
const replies = (ctx: ReturnType<typeof setup>["ctx"], id: string) =>
  ctx.db.select().from(vendorMessages).where(eq(vendorMessages.workItemId, id)).all().filter((m) => m.direction === "inbound");

describe("simulated vendor", () => {
  beforeEach(() => {
    process.env.MOCK_VENDOR_DELAY_MS = "0";
  });
  afterEach(() => {
    delete process.env.MOCK_VENDOR_OUTCOME;
    delete process.env.MOCK_VENDOR;
  });

  it("is on when no email transport is configured", async () => {
    const { ctx } = await openDispute();
    expect(mockVendorEnabled(ctx)).toBe(true);
    process.env.MOCK_VENDOR = "off";
    expect(mockVendorEnabled(ctx)).toBe(false);
  });

  it("grants the full credit and the Vendor Liaison closes the case", async () => {
    process.env.MOCK_VENDOR_OUTCOME = "credit";
    const { ctx, orchestrator, id } = await openDispute();
    expect(await runMockVendor(ctx)).toBe(1);
    await orchestrator.drain();
    expect(replies(ctx, id)[0].fromAddr).toMatch(/simulated/);
    expect(disputeOf(ctx, id).status).toBe("CREDIT_ACCEPTED");
    // Nothing more to answer once the case is closed.
    expect(await runMockVendor(ctx)).toBe(0);
  });

  it("asks for evidence, gets an answer from the Vendor Liaison, then settles", async () => {
    process.env.MOCK_VENDOR_OUTCOME = "evidence";
    const { ctx, orchestrator, id } = await openDispute();
    await runMockVendor(ctx);
    await orchestrator.drain();
    expect(disputeOf(ctx, id).status).toBe("SUBMITTED");
    expect(await runMockVendor(ctx)).toBe(1);
    await orchestrator.drain();
    expect(replies(ctx, id)).toHaveLength(2);
    expect(disputeOf(ctx, id).status).toBe("CREDIT_ACCEPTED");
  });

  it("brings a partial offer to the controller instead of booking it", async () => {
    process.env.MOCK_VENDOR_OUTCOME = "partial";
    const { ctx, orchestrator, id } = await openDispute();
    await runMockVendor(ctx);
    await orchestrator.drain();
    expect(replies(ctx, id)[0].body).toContain("$900.00");
    expect(replies(ctx, id)[0].status).toBe("waiting_on_controller");
    expect(disputeOf(ctx, id).status).toBe("SUBMITTED");
    // Waiting on the controller: the vendor does not keep writing.
    expect(await runMockVendor(ctx)).toBe(0);
  });
});
