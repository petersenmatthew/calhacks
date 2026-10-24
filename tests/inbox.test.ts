import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { vendorDisputes, vendorMessages } from "@/server/db/schema";
import { ACTOR } from "@/server/security/actors";
import { runScenario } from "@/server/sim/scenarios";
import { decideApproval } from "@/server/workflow/approvals";
import { pendingApprovals, setup } from "./helpers";

const mailbox: { uid: number; source: Buffer }[] = [];

vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect() {}
    async logout() {}
    async getMailboxLock() {
      return { release() {} };
    }
    async search() {
      return mailbox.map((m) => m.uid);
    }
    async *fetch(uids: number[]) {
      for (const m of mailbox) if (uids.includes(m.uid)) yield { uid: m.uid, source: m.source, internalDate: new Date() };
    }
  },
}));

function eml(headers: Record<string, string>, body: string) {
  return Buffer.from(Object.entries(headers).map(([k, v]) => k + ": " + v).join("\r\n") + "\r\n\r\n" + body);
}

describe("AP mailbox", () => {
  it("reads vendor replies over IMAP, skips our own letters, and never reads a message twice", async () => {
    const { ctx, orchestrator } = setup(":memory:", { comms: { vendorEmail: "ap@gmail.test", imapUrl: "imaps://ap%40gmail.test:pw@imap.gmail.test:993", inboxPollMs: 30_000 } as never });
    await orchestrator.drain();
    const ingest = runScenario(ctx, "overbilling");
    const id = ingest.status === "work_item_created" ? ingest.workItemId : "";
    await orchestrator.drain();
    decideApproval(ctx, { approvalId: pendingApprovals(ctx, id)[0].id, actorId: ACTOR.controller, decision: "APPROVED" });
    await orchestrator.drain();
    const dispute = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, id)).get()!;
    const date = new Date(Date.now() + 60_000).toUTCString();
    mailbox.push(
      // Our own letter, delivered to the same Gmail inbox because VENDOR_EMAIL is the AP address.
      { uid: 1, source: eml({ From: "ap@gmail.test", To: "ap@gmail.test", Subject: dispute.letterSubject!, "Message-ID": "<ours@x>", "X-Atlas-Outbox": "1", Date: date }, "Atlas Research disputes $1,200.00") },
      {
        uid: 2,
        source: eml(
          { From: "Helios Billing <billing@helios.test>", To: "ap@gmail.test", Subject: "Re: " + dispute.letterSubject, "Message-ID": "<reply-1@helios.test>", Date: date },
          "We have denied this request; the charge stands.\r\n\r\nOn Fri, Oct 24, 2026 at 9:14 AM AP <ap@gmail.test> wrote:\r\n> Atlas Research disputes",
        ),
      },
    );
    const { pollVendorInbox } = await import("@/server/comms/inbox");
    const first = await pollVendorInbox(ctx, { force: true });
    expect(first?.checked).toBe(2);
    expect(first?.results).toEqual([expect.objectContaining({ status: "recorded", disputeId: dispute.id })]);
    const rows = ctx.db.select().from(vendorMessages).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromAddr: "billing@helios.test", messageId: "<reply-1@helios.test>", body: "We have denied this request; the charge stands." });
    expect((await pollVendorInbox(ctx, { force: true }))?.checked).toBe(0);
    await orchestrator.drain();
    expect(ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.id, dispute.id)).get()!.status).toBe("DENIED");
  });
});
