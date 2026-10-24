import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchOutbox } from "@/server/comms/dispatch";
import { outbox, vendorDisputes } from "@/server/db/schema";
import { ACTOR } from "@/server/security/actors";
import { runScenario } from "@/server/sim/scenarios";
import { decideApproval } from "@/server/workflow/approvals";
import { pendingApprovals, proposalsFor, setup } from "./helpers";

const VENDOR = "vendor-inbox@example.test";

async function sendOverbillingDispute(config: Parameters<typeof setup>[1] = {}) {
  const { ctx, orchestrator } = setup(":memory:", { ...config, comms: { vendorEmail: VENDOR, ...(config.comms ?? {}) } as never });
  await orchestrator.drain();
  const ingest = runScenario(ctx, "overbilling");
  const id = ingest.status === "work_item_created" ? ingest.workItemId : "";
  await orchestrator.drain();
  decideApproval(ctx, { approvalId: pendingApprovals(ctx, id)[0].id, actorId: ACTOR.controller, decision: "APPROVED" });
  await orchestrator.drain();
  return { ctx, orchestrator, id };
}

afterEach(() => vi.unstubAllGlobals());

describe("dispute letters", () => {
  it("cites only the clauses that apply and attaches the evidence from the systems of record", async () => {
    const { ctx, id } = await sendOverbillingDispute();
    const [proposal] = proposalsFor(ctx, id);
    // Billed after termination: termination and metering apply, plus the dispute-window clause. Minimum duration does not.
    expect(proposal.payload.dispute?.clauseRefs).toEqual(["4.2", "4.1", "7.2"]);

    const dispute = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, id)).get()!;
    expect(dispute.sentTo).toBe(VENDOR);
    expect(dispute.letterSubject).toContain(dispute.vendorReference!);
    const body = dispute.letterBody!;
    expect(body).toContain("$1,200.00");
    expect(body).toContain("i-hel-4471");
    expect(body).toContain("TERMINATED      2026-10-15 08:00 UTC");
    expect(body).toContain("hel-api-req-7f3a91");
    expect(body).toContain("Termination ends billing");
    expect(body).not.toContain("Minimum duration");
    expect(body).toContain("Disputed: $3,600.00 - $2,400.00 = $1,200.00.");

    const email = ctx.db.select().from(outbox).where(and(eq(outbox.channel, "email"), eq(outbox.ref, dispute.id))).get()!;
    expect(email.destination).toBe(VENDOR);
    expect(email.body).toBe(body);
    expect(email.attachments[0].filename).toBe(dispute.id + "-evidence.csv");
    expect(email.attachments[0].content).toContain("termination_api_ack,\"hel-api-req-7f3a91\"");
  });

  it("pings the controller in Slack when an approval is needed and when a dispute goes out", async () => {
    const { ctx, id } = await sendOverbillingDispute();
    const slack = ctx.db.select().from(outbox).where(eq(outbox.channel, "slack")).all().filter((m) => m.workItemId === id);
    const approval = slack.find((m) => m.event === "approval.requested")!;
    expect(approval.destination).toBe("#finance-approvals");
    expect(approval.body.startsWith("<@priya>")).toBe(true);
    expect(slack.find((m) => m.event === "dispute.sent")?.destination).toBe("#vendor-disputes");
  });
});

describe("delivery", () => {
  it("keeps messages as simulated when no email or Slack is configured", async () => {
    const { ctx } = await sendOverbillingDispute();
    for (let i = 0; i < 10; i++) await dispatchOutbox(ctx);
    const rows = ctx.db.select().from(outbox).all();
    expect(rows.every((r) => r.status === "simulated")).toBe(true);
    const dispute = ctx.db.select().from(vendorDisputes).all()[0];
    expect(dispute.emailStatus).toBe("simulated");
  });

  it("sends the dispute through Resend and records the provider's message id", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("resend.com")) return new Response(JSON.stringify({ id: "re_123" }), { status: 200 });
      if (url.includes("conversations.list")) {
        const channels = ["finance-approvals", "vendor-disputes", "budget-alerts", "finance-ops"].map((name, i) => ({ id: "C0" + i + "TEST", name, is_member: true }));
        return new Response(JSON.stringify({ ok: true, channels }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, ts: "1.2" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = await sendOverbillingDispute({ comms: { resendApiKey: "re_test", slackBotToken: "xoxb-test", slackUserIds: { priya: "U01PRIYA" } } as never });
    for (let i = 0; i < 10; i++) await dispatchOutbox(ctx);
    const email = ctx.db.select().from(outbox).where(and(eq(outbox.channel, "email"), eq(outbox.event, "dispute.sent"))).get()!;
    expect(email.status).toBe("sent");
    expect(email.providerMessageId).toBe("re_123");
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("resend.com"))!;
    const sentBody = JSON.parse(String((call as unknown as [string, RequestInit])[1].body));
    expect(sentBody.to).toEqual([VENDOR]);
    expect(sentBody.attachments).toHaveLength(1);
    const slackCall = fetchMock.mock.calls.find(([u]) => String(u).includes("chat.postMessage"))!;
    expect(String((slackCall as unknown as [string, RequestInit])[1].body)).toContain("<@U01PRIYA>");
    expect(ctx.db.select().from(vendorDisputes).all()[0].emailStatus).toBe("sent");
    // Every email we send is marked, so the inbox poller never reads our own letter back as a vendor reply.
    expect(sentBody.headers["X-Atlas-Outbox"]).toBe("1");
  });
});

describe("Slack users", () => {
  it("reads who is who from usernames, role keys, JSON, or one id", async () => {
    const { parseUserIds } = await import("@/server/runtime");
    expect(parseUserIds("controller=belinda, cfo=matthewpetersen, leads=@matthewpetersen")).toEqual({
      priya: "belinda",
      dana: "matthewpetersen",
      maya: "matthewpetersen",
      ravi: "matthewpetersen",
      elena: "matthewpetersen",
      diego: "matthewpetersen",
    });
    expect(parseUserIds('{"priya":"U01PRIYA"}')).toEqual({ priya: "U01PRIYA" });
    expect(parseUserIds("U0CBY1LDMNV")).toEqual({ "*": "U0CBY1LDMNV" });
    expect(parseUserIds('"cfo":U0CBY1LDMNV')).toEqual({ dana: "U0CBY1LDMNV" });
  });

  it("looks usernames up in Slack and mentions the right person", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("users.list")) {
        return new Response(JSON.stringify({ ok: true, members: [{ id: "UBELINDA1", name: "unicornbelinda", real_name: "belinda" }, { id: "UMATTHEW1", name: "matthewpetersen" }] }), { status: 200 });
      }
      if (url.includes("conversations.list")) return new Response(JSON.stringify({ ok: true, channels: [{ id: "C0FINOPS", name: "finance-ops", is_member: true }] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, ts: "1.2" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { setup } = await import("./helpers");
    const { sendSlack, resetSlackCache } = await import("@/server/comms/transports");
    resetSlackCache();
    const { ctx } = setup(":memory:", { comms: { slackBotToken: "xoxb-test", slackUserIds: { priya: "belinda", dana: "matthewpetersen" } } as never });
    await sendSlack(ctx, "#finance-ops", "<@priya> approve this; <@dana> FYI");
    const post = fetchMock.mock.calls.find(([u]) => String(u).includes("chat.postMessage"))!;
    expect(String((post as unknown as [string, RequestInit])[1].body)).toContain("<@UBELINDA1> approve this; <@UMATTHEW1> FYI");
    const invite = fetchMock.mock.calls.find(([u]) => String(u).includes("conversations.invite"))!;
    expect(String((invite as unknown as [string, RequestInit])[1].body)).toContain("UBELINDA1,UMATTHEW1");
  });
});
