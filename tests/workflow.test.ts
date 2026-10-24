import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAppContext } from "@/server/context";
import { activityEvents, auditEvents, journalEntries, policies, vendorDisputes, workItems } from "@/server/db/schema";
import { Orchestrator } from "@/server/orchestrator";
import { ACTOR } from "@/server/security/actors";
import { ControlError } from "@/server/security/errors";
import { runScenario } from "@/server/sim/scenarios";
import { decideApproval } from "@/server/workflow/approvals";
import { recordVendorResponse } from "@/server/workflow/decisions";
import { postJournalEntry } from "@/server/workflow/ledger";
import { setAgentSettings } from "@/server/settings";
import { verifyAuditChain } from "@/server/audit";
import {
  accountBalance,
  pendingApprovals,
  projectExpense,
  proposalsFor,
  setup,
  tempDbFile,
  unbalancedEntries,
  workItem,
} from "./helpers";

describe("seeded month", () => {
  it("auto-matches clean lines and explains a correctly billed instance whose job ended early", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    const id = ctx.db.select().from(workItems).where(eq(workItems.invoiceLineId, "HEL-2026-10-121-L1")).get()!.id;
    const item = workItem(ctx, id);
    expect(item.state).toBe("RESOLVED");
    expect(item.outcome).toBe("CHARGE_EXPLAINED");
    expect(ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, id)).all()).toHaveLength(0);
    expect(proposalsFor(ctx, id).every((p) => p.kind === "ALLOCATION")).toBe(true);
    expect(unbalancedEntries(ctx)).toHaveLength(0);
  });
});

describe("Scenario 1: suspected GPU overbilling", () => {
  it("in one-at-a-time mode, opens on the overbilling case and starts the next case only when it leaves the team", async () => {
    const { ctx, orchestrator } = setup(":memory:", { defaultRunMode: "one" });
    await orchestrator.drain();
    const opening = workItem(ctx, "WI-1001");
    expect(opening.invoiceLineId).toBe("HEL-2026-10-133-L2");
    expect(opening.state).toBe("NEEDS_APPROVAL");
    const others = ctx.db.select().from(workItems).all().filter((i) => i.id !== "WI-1001");
    expect(others.every((i) => i.state === "NEW")).toBe(true);

    const [approval] = pendingApprovals(ctx, "WI-1001");
    decideApproval(ctx, { approvalId: approval.id, actorId: ACTOR.controller, decision: "APPROVED" });
    await orchestrator.drain();
    expect(workItem(ctx, "WI-1001").state).toBe("DISPUTED");
    expect(workItem(ctx, "WI-1002").state).not.toBe("NEW");
    expect(workItem(ctx, "WI-1003").state).toBe("NEW");
  });

  it("disputes $1,200, waits for approval, and keeps the liability until the vendor credits", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    const apBefore = accountBalance(ctx, "2000");
    const ingest = runScenario(ctx, "overbilling");
    expect(ingest.status).toBe("work_item_created");
    const id = ingest.status === "work_item_created" ? ingest.workItemId : "";
    await orchestrator.drain();

    const item = workItem(ctx, id);
    expect(item.state).toBe("NEEDS_APPROVAL");
    const [proposal] = proposalsFor(ctx, id);
    expect(proposal.kind).toBe("VENDOR_DISPUTE");
    expect(proposal.payload.dispute?.disputedCents).toBe(120_000);
    expect(proposal.payload.dispute?.undisputedCents).toBe(240_000);
    expect(accountBalance(ctx, "2000") - apBefore).toBe(360_000);

    const [approval] = pendingApprovals(ctx, id);
    decideApproval(ctx, { approvalId: approval.id, actorId: ACTOR.controller, decision: "APPROVED" });
    await orchestrator.drain();
    expect(workItem(ctx, id).state).toBe("DISPUTED");
    // The Vendor Liaison wrote and sent the dispute; the ledger gateway submitted it.
    const sent = ctx.db.select().from(activityEvents).where(eq(activityEvents.toolName, "send_vendor_dispute")).get();
    expect(sent?.actorId).toBe(ACTOR.vendorLiaison);
    // Proposing or submitting a dispute does not reduce the recorded liability.
    expect(accountBalance(ctx, "2000") - apBefore).toBe(360_000);

    recordVendorResponse(ctx, { workItemId: id, outcome: "accept" });
    // The vendor's reply alone changes nothing on the books until the Vendor Liaison closes the case.
    expect(accountBalance(ctx, "2000") - apBefore).toBe(360_000);
    await orchestrator.drain();
    expect(workItem(ctx, id).state).toBe("RESOLVED");
    expect(accountBalance(ctx, "2000") - apBefore).toBe(240_000);
    expect(unbalancedEntries(ctx)).toHaveLength(0);
  });
});

describe("Scenarios 2 and 3: shared allocation, human correction, and persistent policy learning", () => {
  it("reworks a rejected allocation, learns a policy, and applies it next month after a restart", async () => {
    const file = tempDbFile();
    const first = setup(file);
    await first.orchestrator.drain();
    const ingest = runScenario(first.ctx, "shared_allocation");
    const id = ingest.status === "work_item_created" ? ingest.workItemId : "";
    await first.orchestrator.drain();

    expect(workItem(first.ctx, id).state).toBe("NEEDS_APPROVAL");
    // The agent tried to post under written policy v1; the gateway denied it because v1 conflicts with the reservation terms.
    const denials = first.ctx.db.select().from(auditEvents).where(eq(auditEvents.outcome, "DENIED")).all();
    expect(denials.some((d) => d.action === "tool:submit_for_posting" && d.rule === "APPROVAL_REQUIRED")).toBe(true);
    const [v1] = proposalsFor(first.ctx, id);
    expect(v1.method).toBe("usage_proportional");
    expect(Object.fromEntries(v1.payload.allocation.map((l) => [l.projectId, l.amountCents]))).toEqual({
      "PRJ-FLM": 697_500,
      "PRJ-MMP": 542_500,
    });

    const [approval] = pendingApprovals(first.ctx, id);
    decideApproval(first.ctx, {
      approvalId: approval.id,
      actorId: ACTOR.controller,
      decision: "REJECTED",
      reason: "Reserved capacity must be charged to the team that owns the reservation, subject to company policy.",
    });
    await first.orchestrator.drain();

    const versions = proposalsFor(first.ctx, id);
    expect(versions[0].status).toBe("REJECTED");
    expect(versions[0].payload.allocation).toEqual(v1.payload.allocation);
    const v2 = versions[versions.length - 1];
    expect(v2.method).toBe("owner_pays_idle");
    expect(v2.version).toBe(2);
    expect(Object.fromEntries(v2.payload.allocation.map((l) => [l.projectId, l.amountCents]))).toEqual({
      "PRJ-FLM": 806_000,
      "PRJ-MMP": 434_000,
    });

    const pending = pendingApprovals(first.ctx, id);
    expect(pending.map((p) => p.subjectType).sort()).toEqual(["POLICY", "PROPOSAL"]);
    for (const p of pending) decideApproval(first.ctx, { approvalId: p.id, actorId: ACTOR.controller, decision: "APPROVED" });
    await first.orchestrator.drain();

    expect(workItem(first.ctx, id).state).toBe("RESOLVED");
    const entry = first.ctx.db.select().from(journalEntries).where(eq(journalEntries.proposalId, v2.id)).get();
    expect(entry?.totalCents).toBe(1_240_000);
    expect(unbalancedEntries(first.ctx)).toHaveLength(0);
    first.ctx.sqlite.close();

    // Restart: open the same database file in a fresh context.
    const ctx = createAppContext({ file, config: { stepDelayMs: 0 } });
    const orchestrator = new Orchestrator(ctx);
    const learned = ctx.db.select().from(policies).where(eq(policies.id, "POL-ALLOC-SHARED-v2")).get();
    expect(learned?.status).toBe("APPROVED");
    expect(learned?.learnedFromWorkItemId).toBe(id);
    expect(learned?.proposedBy).toBe(ACTOR.policy);

    const next = runScenario(ctx, "next_month_shared");
    const nextId = next.status === "work_item_created" ? next.workItemId : "";
    await orchestrator.drain();
    const nextItem = workItem(ctx, nextId);
    expect(nextItem.state).toBe("RESOLVED");
    expect(nextItem.outcome).toBe("ALLOCATED_UNDER_POLICY");
    expect(pendingApprovals(ctx, nextId)).toHaveLength(0);
    const nextEntry = ctx.db.select().from(journalEntries).where(eq(journalEntries.workItemId, nextId)).get();
    expect(nextEntry?.policyId).toBe("POL-ALLOC-SHARED-v2");
    expect(projectExpense(ctx, "PRJ-MMP", [nextEntry!.id])).toBe(705_600);
    expect(projectExpense(ctx, "PRJ-RLA", [nextEntry!.id])).toBe(302_400);
  });
});

describe("controls", () => {
  it("holds a paused employee's work in the queue without blocking anyone else", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    const ingest = runScenario(ctx, "overbilling");
    const id = ingest.status === "work_item_created" ? ingest.workItemId : "";
    await orchestrator.drain();
    setAgentSettings(ctx, ACTOR.controller, ACTOR.vendorLiaison, { paused: true });
    const [approval] = pendingApprovals(ctx, id);
    decideApproval(ctx, { approvalId: approval.id, actorId: ACTOR.controller, decision: "APPROVED" });
    await orchestrator.drain();
    // The approval itself still executes; only the paused Vendor Liaison waits.
    expect(workItem(ctx, id).state).toBe("APPROVED");
    setAgentSettings(ctx, ACTOR.controller, ACTOR.vendorLiaison, { paused: false });
    await orchestrator.drain();
    expect(workItem(ctx, id).state).toBe("DISPUTED");
    expect(() => setAgentSettings(ctx, ACTOR.finance, ACTOR.vendorLiaison, { paused: true })).toThrow(ControlError);
  });

  it("denies agents approving or posting and logs every denial", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    const ingest = runScenario(ctx, "overbilling");
    const id = ingest.status === "work_item_created" ? ingest.workItemId : "";
    await orchestrator.drain();
    const [approval] = pendingApprovals(ctx, id);

    expect(() => decideApproval(ctx, { approvalId: approval.id, actorId: ACTOR.finance, decision: "APPROVED" })).toThrow(ControlError);
    expect(() =>
      postJournalEntry(ctx, {
        actorId: ACTOR.finance,
        period: "2026-10",
        memo: "agent tries to post",
        source: "experiment_ledger",
        authorization: "none",
        idempotencyKey: "attack-1",
        lines: [
          { accountCode: "6100", projectId: "PRJ-FLM", debitCents: 100, creditCents: 0, memo: "x" },
          { accountCode: "6990", projectId: null, debitCents: 0, creditCents: 100, memo: "x" },
        ],
      }),
    ).toThrow(ControlError);
    expect(() =>
      postJournalEntry(ctx, {
        actorId: ACTOR.ledger,
        period: "2026-10",
        memo: "gateway without approval",
        source: "experiment_ledger",
        authorization: "none",
        idempotencyKey: "attack-2",
        lines: [
          { accountCode: "6100", projectId: "PRJ-FLM", debitCents: 100, creditCents: 0, memo: "x" },
          { accountCode: "6990", projectId: null, debitCents: 0, creditCents: 100, memo: "x" },
        ],
      }),
    ).toThrow(/approved/);

    const denied = ctx.db.select().from(auditEvents).where(eq(auditEvents.outcome, "DENIED")).all();
    expect(denied.map((d) => d.actorId)).toEqual(expect.arrayContaining([ACTOR.finance, ACTOR.ledger]));
    expect(pendingApprovals(ctx, id)).toHaveLength(1);
    expect(ctx.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, "attack-1")).all()).toHaveLength(0);
  });

  it("rejects unbalanced entries", async () => {
    const { ctx } = setup();
    expect(() =>
      postJournalEntry(ctx, {
        actorId: ACTOR.erp,
        period: "2026-10",
        memo: "unbalanced",
        source: "erp_ap",
        authorization: "test",
        idempotencyKey: "unbalanced-1",
        lines: [
          { accountCode: "6990", projectId: null, debitCents: 1000, creditCents: 0, memo: "x" },
          { accountCode: "2000", projectId: null, debitCents: 0, creditCents: 999, memo: "x" },
        ],
      }),
    ).toThrow(/Unbalanced/);
  });

  it("ignores a repeated billing event without duplicating work or postings", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    runScenario(ctx, "overbilling");
    await orchestrator.drain();
    const items = ctx.db.select().from(workItems).all().length;
    const entries = ctx.db.select().from(journalEntries).all().length;
    const result = runScenario(ctx, "duplicate");
    await orchestrator.drain();
    expect(result.status).toBe("duplicate");
    expect(ctx.db.select().from(workItems).all()).toHaveLength(items);
    expect(ctx.db.select().from(journalEntries).all()).toHaveLength(entries);
  });

  it("keeps the audit log append-only and hash-chained", async () => {
    const { ctx, orchestrator } = setup();
    await orchestrator.drain();
    expect(() => ctx.sqlite.prepare("UPDATE audit_events SET action = 'tampered' WHERE id = 1").run()).toThrow(/append-only/);
    expect(() => ctx.sqlite.prepare("DELETE FROM journal_lines").run()).toThrow(/append-only/);
    expect(verifyAuditChain(ctx).ok).toBe(true);
  });
});
