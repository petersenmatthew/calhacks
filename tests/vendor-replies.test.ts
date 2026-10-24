import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { invokeTool } from "@/server/agents/gateway";
import { outbox, vendorDisputes, vendorMessages } from "@/server/db/schema";
import { ACTOR } from "@/server/security/actors";
import { runScenario } from "@/server/sim/scenarios";
import { decideApproval } from "@/server/workflow/approvals";
import { provideInformation } from "@/server/workflow/info";
import { receiveVendorEmail, stripQuoted } from "@/server/workflow/vendor-replies";
import { accountBalance, pendingApprovals, setup, unbalancedEntries, workItem } from "./helpers";

async function openDispute() {
  const { ctx, orchestrator } = setup(":memory:", { comms: { vendorEmail: "vendor@example.test" } as never });
  await orchestrator.drain();
  const ingest = runScenario(ctx, "overbilling");
  const id = ingest.status === "work_item_created" ? ingest.workItemId : "";
  await orchestrator.drain();
  decideApproval(ctx, { approvalId: pendingApprovals(ctx, id)[0].id, actorId: ACTOR.controller, decision: "APPROVED" });
  await orchestrator.drain();
  const dispute = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, id)).get()!;
  expect(dispute.status).toBe("SUBMITTED");
  // Pretend the letter went out over SMTP with this Message-ID, so a reply can thread to it.
  ctx.db.update(outbox).set({ status: "sent", providerMessageId: "<letter-1@atlas.test>" }).where(and(eq(outbox.channel, "email"), eq(outbox.ref, dispute.id))).run();
  return { ctx, orchestrator, id, dispute };
}

function vendorSays(ctx: ReturnType<typeof setup>["ctx"], dispute: { letterSubject: string | null }, text: string, messageId = "<v" + Math.random() + "@vendor.test>") {
  return receiveVendorEmail(ctx, {
    from: "billing@helios.test",
    subject: "Re: " + dispute.letterSubject,
    text: text + "\n\nOn Fri, Oct 24, 2026 at 9:14 AM Atlas Research AP <ap@atlas.test> wrote:\n> Atlas Research disputes $1,200.00 ...",
    messageId,
    inReplyTo: "<letter-1@atlas.test>",
    receivedAt: new Date(Date.now() + 1000).toISOString(),
  });
}

const inbound = (ctx: ReturnType<typeof setup>["ctx"], id: string) =>
  ctx.db.select().from(vendorMessages).where(and(eq(vendorMessages.workItemId, id), eq(vendorMessages.direction, "inbound"))).all();
const outbound = (ctx: ReturnType<typeof setup>["ctx"], id: string) =>
  ctx.db.select().from(vendorMessages).where(and(eq(vendorMessages.workItemId, id), eq(vendorMessages.direction, "outbound"))).all();

describe("vendor replies", () => {
  it("strips the quoted original from a reply", () => {
    expect(stripQuoted("Thanks, we'll check.\n\nOn Fri, Oct 24, 2026 at 9:14 AM Atlas <a@b.c> wrote:\n> old text")).toBe("Thanks, we'll check.");
    expect(stripQuoted("Line one\n> quoted\nLine two")).toBe("Line one\nLine two");
  });

  it("matches a reply to its dispute by thread, stores it once, and answers a records request with the evidence", async () => {
    const { ctx, orchestrator, id, dispute } = await openDispute();
    const r = vendorSays(ctx, dispute, "Hi, can you send the usage records and your termination timestamps for this instance?", "<q1@vendor.test>");
    expect(r).toMatchObject({ status: "recorded", disputeId: dispute.id, routed: true });
    expect(vendorSays(ctx, dispute, "dup", "<q1@vendor.test>").status).toBe("duplicate");
    expect(inbound(ctx, id)[0].body).not.toContain("wrote:");
    await orchestrator.drain();

    const [reply] = outbound(ctx, id);
    expect(reply.subject).toBe("Re: " + dispute.letterSubject);
    expect(inbound(ctx, id)[0].status).toBe("handled");
    const email = ctx.db.select().from(outbox).where(and(eq(outbox.channel, "email"), eq(outbox.event, "dispute.reply_sent"))).get()!;
    expect(email.destination).toBe("billing@helios.test");
    expect(email.headers?.["In-Reply-To"]).toBe("<q1@vendor.test>");
    expect(email.headers?.["References"]).toContain("<letter-1@atlas.test>");
    expect(email.attachments[0].filename).toBe(dispute.id + "-evidence.csv");
    expect(email.body).toContain("i-hel-4471");
    expect(workItem(ctx, id).state).toBe("DISPUTED");
  });

  it("books the vendor's full credit with their memo number and closes the case", async () => {
    const { ctx, orchestrator, id, dispute } = await openDispute();
    const apBefore = accountBalance(ctx, "2000");
    vendorSays(ctx, dispute, "We reviewed the lifecycle logs and have issued credit memo CM-88213 for $1,200.00 against the invoice.");
    await orchestrator.drain();
    const d = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.id, dispute.id)).get()!;
    expect(d.status).toBe("CREDIT_ACCEPTED");
    expect(d.vendorReference).toBe("CM-88213");
    expect(workItem(ctx, id).state).toBe("RESOLVED");
    expect(workItem(ctx, id).outcome).toBe("VENDOR_CREDIT");
    expect(apBefore - accountBalance(ctx, "2000")).toBe(120_000);
    expect(unbalancedEntries(ctx)).toHaveLength(0);
  });

  it("books a refusal as an upheld charge", async () => {
    const { ctx, orchestrator, id, dispute } = await openDispute();
    vendorSays(ctx, dispute, "After review we have denied this request. The instance was metered correctly.");
    await orchestrator.drain();
    expect(workItem(ctx, id).outcome).toBe("CHARGE_UPHELD");
  });

  it("only notes an acknowledgement and keeps waiting", async () => {
    const { ctx, orchestrator, id, dispute } = await openDispute();
    vendorSays(ctx, dispute, "Thanks, our billing team is reviewing this and will get back to you within 5 business days.");
    await orchestrator.drain();
    expect(inbound(ctx, id)[0]).toMatchObject({ status: "handled", kind: "update" });
    expect(outbound(ctx, id)).toHaveLength(0);
    expect(workItem(ctx, id).state).toBe("DISPUTED");
  });

  it("takes a partial-credit offer to the controller, then books it once the controller accepts", async () => {
    const { ctx, orchestrator, id, dispute } = await openDispute();
    vendorSays(ctx, dispute, "We can offer a goodwill credit of $1,000.00 to close this out.");
    await orchestrator.drain();
    let item = workItem(ctx, id);
    expect(item.state).toBe("DISPUTED");
    expect(item.pendingQuestion?.question).toContain("$1,000.00");
    expect(inbound(ctx, id)[0].status).toBe("waiting_on_controller");
    const ping = ctx.db.select().from(outbox).where(eq(outbox.event, "dispute.controller_question")).all();
    expect(ping.map((p) => p.destination).sort()).toEqual(["#vendor-disputes", "@priya"]);

    provideInformation(ctx, { workItemId: id, actorId: ACTOR.controller, answer: "Yes, accept the $1,000.00 credit and close it." });
    await orchestrator.drain();
    item = workItem(ctx, id);
    expect(item.state).toBe("RESOLVED");
    const d = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.id, dispute.id)).get()!;
    expect(d.creditedCents).toBe(100_000);
    const lines = ctx.sqlite
      .prepare("SELECT account_code, project_id, debit_cents, credit_cents FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.memo LIKE ?")
      .all("Record vendor credit for " + dispute.id + "%") as { account_code: string; project_id: string | null; debit_cents: number }[];
    expect(lines.find((l) => l.account_code === "2000")?.debit_cents).toBe(100_000);
    expect(lines.find((l) => l.account_code === "6100")?.debit_cents).toBe(20_000);
    expect(unbalancedEntries(ctx)).toHaveLength(0);
    expect(outbound(ctx, id)[0].body).toContain("accepts your credit of $1,000.00");
  });

  it("holds out for the full amount when the controller declines an offer", async () => {
    const { ctx, orchestrator, id, dispute } = await openDispute();
    vendorSays(ctx, dispute, "We can offer a goodwill credit of $600.00.");
    await orchestrator.drain();
    provideInformation(ctx, { workItemId: id, actorId: ACTOR.controller, answer: "No, decline and hold out for the full amount." });
    await orchestrator.drain();
    expect(workItem(ctx, id).state).toBe("DISPUTED");
    const [reply] = outbound(ctx, id);
    expect(reply.body).toContain("maintains its dispute of the full $1,200.00");
    expect(inbound(ctx, id)[0].status).toBe("handled");
  });

  it("will not let the liaison put an unapproved amount in writing or accept a partial credit on its own", async () => {
    const { ctx, id, dispute } = await openDispute();
    const r = vendorSays(ctx, dispute, "We can offer $900.00.");
    const messageId = r.status === "recorded" ? r.id : "";
    const run = { runId: "RUN-T", agentId: ACTOR.vendorLiaison, workItemId: id, mode: "deterministic" as const, epoch: ctx.epoch, terminal: null, toolCalls: 0, trigger: {} };
    const reply = await invokeTool(ctx, run, "reply_to_vendor", {
      work_item_id: id,
      answering: [messageId],
      message: "We would be happy to settle this for $900.00 if you can process it this week.",
      attach_evidence: false,
      kind: "counter_offer",
    });
    expect(JSON.stringify(reply)).toContain("not in the approved dispute");
    const partial = await invokeTool(ctx, { ...run, terminal: null }, "record_vendor_decision", {
      work_item_id: id,
      message_id: messageId,
      decision: "partial_credit",
      credit_reference: null,
      credit_amount_cents: 90_000,
      confirmation_message: null,
      summary: "Taking the offer.",
    });
    expect(JSON.stringify(partial)).toContain("needs the controller");
    expect(workItem(ctx, id).state).toBe("DISPUTED");
  });

  it("ignores mail older than the dispute (old replies after a demo reset)", async () => {
    const { ctx, dispute } = await openDispute();
    const r = receiveVendorEmail(ctx, {
      from: "billing@helios.test",
      subject: "Re: " + dispute.letterSubject,
      text: "Credit issued.",
      messageId: "<old@vendor.test>",
      receivedAt: "2020-01-01T00:00:00.000Z",
    });
    expect(r.status).toBe("unmatched");
  });
});
