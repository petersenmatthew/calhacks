import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { advanceClock } from "@/server/clock";
import { approvalRequests, followUps, policies, workItems } from "@/server/db/schema";
import { runScheduledWork } from "@/server/scheduler";
import { ACTOR } from "@/server/security/actors";
import { syncHttpFeed } from "@/server/sync/feeds";
import { decideApproval } from "@/server/workflow/approvals";
import { ONBOARDING_ID } from "@/server/workflow/onboarding";
import { pendingApprovals, proposalsFor, setup, unbalancedEntries } from "./helpers";

function itemByLine(ctx: ReturnType<typeof setup>["ctx"], lineId: string) {
  return ctx.db.select().from(workItems).where(eq(workItems.invoiceLineId, lineId)).get();
}

function onboardingApproval(ctx: ReturnType<typeof setup>["ctx"]) {
  return ctx.db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.workItemId, ONBOARDING_ID), eq(approvalRequests.status, "PENDING")))
    .get();
}

describe("onboarding: learning from AP history", () => {
  it("mines six months of AP lines and proposes a materiality threshold the history supports", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    const policy = ctx.db.select().from(policies).where(eq(policies.policyKey, "VARIANCE-MATERIALITY")).get();
    expect(policy?.status).toBe("PROPOSED");
    // Largest variance paid as billed was $48; smallest the vendor credited was $192.
    expect(policy?.rule.thresholdCents).toBe(5_000);
    expect(policy?.proposedBy).toBe(ACTOR.policy);
    const approval = onboardingApproval(ctx);
    expect(approval?.subjectId).toBe(policy?.id);
    // The agent cannot approve its own policy.
    expect(() => decideApproval(ctx, { approvalId: approval!.id, actorId: ACTOR.finance, decision: "APPROVED" })).toThrow();
    decideApproval(ctx, { approvalId: approval!.id, actorId: ACTOR.controller, decision: "APPROVED" });
    expect(ctx.db.select().from(policies).where(eq(policies.id, policy!.id)).get()?.status).toBe("APPROVED");
  });
});

describe("scheduled feed sync", () => {
  it("pulls published lines on a cursor, never twice, and the agents resolve them without clicks", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    decideApproval(ctx, { approvalId: onboardingApproval(ctx)!.id, actorId: ACTOR.controller, decision: "APPROVED" });

    // Nothing is published yet at the start of the sandbox.
    expect((await runScheduledWork(ctx)).feeds).toHaveLength(0);

    advanceClock(ctx, ACTOR.controller, 24 * 10);
    const first = await runScheduledWork(ctx);
    expect(first.feeds.reduce((s, f) => s + f.pulled, 0)).toBe(5);
    expect((await runScheduledWork(ctx)).feeds).toHaveLength(0);
    await orchestrator.drain();

    // Exact matches post automatically.
    expect(itemByLine(ctx, "MER-2026-10-051-L1")).toBeUndefined();
    expect(itemByLine(ctx, "HEL-2026-10-153-L1")).toBeUndefined();
    // $12 rate drift is below the learned $50 threshold: accepted and posted without a dispute.
    const small = itemByLine(ctx, "HEL-2026-10-151-L1")!;
    expect(small.state).toBe("RESOLVED");
    expect(small.outcome).toBe("ACCEPTED_BELOW_MATERIALITY");
    // The 8-hour minimum is explained by the contract and posts under policy.
    expect(itemByLine(ctx, "MER-2026-10-052-L1")!.outcome).toBe("CHARGE_EXPLAINED");
    // Six hours billed after termination is a real overcharge: dispute $600, waiting for approval.
    const over = itemByLine(ctx, "HEL-2026-10-152-L1")!;
    expect(over.state).toBe("NEEDS_APPROVAL");
    expect(proposalsFor(ctx, over.id)[0].payload.dispute?.disputedCents).toBe(60_000);
    expect(unbalancedEntries(ctx)).toHaveLength(0);
  });

  it("without the learned policy, the same $12 variance becomes a dispute that needs approval", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    advanceClock(ctx, ACTOR.controller, 1);
    await runScheduledWork(ctx);
    await orchestrator.drain();
    const small = itemByLine(ctx, "HEL-2026-10-151-L1")!;
    expect(small.state).toBe("NEEDS_APPROVAL");
    expect(proposalsFor(ctx, small.id)[0].kind).toBe("VENDOR_DISPUTE");
  });

  it("polls an HTTP billing feed and ignores events it has already ingested", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    const last = ctx.sqlite.prepare("SELECT payload FROM ingestion_events ORDER BY id DESC LIMIT 1").get() as { payload: string };
    const fake = async () => ({ ok: true, status: 200, json: async () => ({ events: [JSON.parse(last.payload)], next_cursor: "c-1" }) });
    const summary = await syncHttpFeed(ctx, "https://feed.example/billing", fake);
    expect(summary?.duplicates).toBe(1);
    expect(summary?.cursor).toBe("c-1");
  });
});

describe("time-based follow-ups", () => {
  it("reminds, then escalates, a waiting approval exactly once each", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    advanceClock(ctx, ACTOR.controller, 25);
    await runScheduledWork(ctx);
    await runScheduledWork(ctx);
    // Follow the onboarding policy approval; every other waiting approval gets the same treatment.
    const approvalId = onboardingApproval(ctx)!.id;
    const kinds = () => ctx.db.select().from(followUps).all().filter((f) => f.subjectId === approvalId).map((f) => f.kind);
    const perApproval = (kind: string) => {
      const counts = new Map<string, number>();
      for (const f of ctx.db.select().from(followUps).all().filter((x) => x.kind === kind)) counts.set(f.subjectId, (counts.get(f.subjectId) ?? 0) + 1);
      return [...counts.values()];
    };
    expect(kinds()).toEqual(["APPROVAL_REMINDER"]);
    expect(perApproval("APPROVAL_REMINDER").every((n) => n === 1)).toBe(true);
    advanceClock(ctx, ACTOR.controller, 24 * 3);
    await runScheduledWork(ctx);
    await runScheduledWork(ctx);
    expect(kinds().filter((k) => k === "APPROVAL_ESCALATION")).toHaveLength(1);
    expect(perApproval("APPROVAL_ESCALATION").every((n) => n === 1)).toBe(true);
  });

  it("measures waiting time from when the approval was requested, not from the wall clock", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    decideApproval(ctx, { approvalId: onboardingApproval(ctx)!.id, actorId: ACTOR.controller, decision: "APPROVED" });
    advanceClock(ctx, ACTOR.controller, 24 * 4);
    await new Promise((r) => setTimeout(r, 5));
    await runScheduledWork(ctx);
    await orchestrator.drain();
    await runScheduledWork(ctx);
    // The $600 dispute approval was requested after the clock moved; it has not waited a day yet.
    const over = itemByLine(ctx, "HEL-2026-10-152-L1")!;
    const approval = pendingApprovals(ctx, over.id)[0];
    expect(approval).toBeDefined();
    expect(ctx.db.select().from(followUps).all().filter((f) => f.subjectId === approval.id)).toHaveLength(0);
  });

  it("chases an unanswered vendor dispute at 14 days and escalates at 30", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    decideApproval(ctx, { approvalId: onboardingApproval(ctx)!.id, actorId: ACTOR.controller, decision: "APPROVED" });
    advanceClock(ctx, ACTOR.controller, 24 * 4);
    await runScheduledWork(ctx);
    await orchestrator.drain();
    const over = itemByLine(ctx, "HEL-2026-10-152-L1")!;
    decideApproval(ctx, { approvalId: pendingApprovals(ctx, over.id)[0].id, actorId: ACTOR.controller, decision: "APPROVED" });
    await orchestrator.drain();
    expect(ctx.db.select().from(workItems).where(eq(workItems.id, over.id)).get()?.state).toBe("DISPUTED");

    advanceClock(ctx, ACTOR.controller, 24 * 15);
    await runScheduledWork(ctx);
    await orchestrator.drain();
    await runScheduledWork(ctx);
    await orchestrator.drain();
    const messages = () => ctx.db.select().from(followUps).all().filter((f) => f.workItemId === over.id);
    expect(messages().filter((f) => f.kind === "VENDOR_MESSAGE")).toHaveLength(1);
    expect(messages().some((f) => f.kind === "ESCALATION_NOTE")).toBe(false);

    advanceClock(ctx, ACTOR.controller, 24 * 16);
    await runScheduledWork(ctx);
    await orchestrator.drain();
    await runScheduledWork(ctx);
    await orchestrator.drain();
    expect(messages().filter((f) => f.kind === "ESCALATION_NOTE")).toHaveLength(1);
    // Still disputed: chasing never changes the books.
    expect(ctx.db.select().from(workItems).where(eq(workItems.id, over.id)).get()?.state).toBe("DISPUTED");
  });
});
