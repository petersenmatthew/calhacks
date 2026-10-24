import { eq } from "drizzle-orm";
import type { AppContext } from "../context";
import { vendorDisputes } from "../db/schema";
import { receiveVendorEmail, type InboundEmail, type ReceiveResult } from "../workflow/vendor-replies";
import { OUR_HEADER } from "./transports";

/*
 * Reads vendor replies from the AP mailbox over IMAP (Gmail: same app
 * password as SMTP). Only messages that mention a case reference are
 * fetched, our own outgoing letters are skipped by their header, and each
 * message is stored once by its Message-ID, so polling is safe to repeat.
 */

let lastPoll = 0;
let polling = false;
const seen = new Set<string>();

export function inboxConfigured(ctx: AppContext) {
  return Boolean(ctx.config.comms.imapUrl);
}

function connection(url: string) {
  const u = new URL(url);
  const secure = u.protocol === "imaps:";
  return {
    host: u.hostname,
    port: Number(u.port || (secure ? 993 : 143)),
    secure,
    auth: { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) },
    logger: false as const,
  };
}

/** Earliest submission among open disputes, minus a day of slack for time zones. */
function searchSince(ctx: AppContext) {
  const open = ctx.db.select({ at: vendorDisputes.submittedAt }).from(vendorDisputes).where(eq(vendorDisputes.status, "SUBMITTED")).all();
  if (!open.length) return null;
  const first = open.map((o) => o.at).sort()[0];
  return new Date(new Date(first).getTime() - 24 * 3600 * 1000);
}

export interface InboxCheck {
  checked: number;
  results: ReceiveResult[];
}

/** Fetch new vendor replies and hand each to receiveVendorEmail. Throttled unless force is set. */
export async function pollVendorInbox(ctx: AppContext, options: { force?: boolean } = {}): Promise<InboxCheck | null> {
  const c = ctx.config.comms;
  if (!c.imapUrl || (!options.force && (c.inboxPollMs <= 0 || Date.now() - lastPoll < c.inboxPollMs))) return null;
  if (polling) return null;
  const since = searchSince(ctx);
  lastPoll = Date.now();
  if (!since) return { checked: 0, results: [] };
  polling = true;
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const client = new ImapFlow(connection(c.imapUrl));
  const inbound: InboundEmail[] = [];
  let checked = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      // Case references look like HELIOS-CASE-6001; matchDispute does the exact match.
      const uids = (await client.search({ since, subject: "CASE" }, { uid: true })) || [];
      const fresh = uids.filter((uid) => !seen.has(String(uid)));
      if (fresh.length) {
        for await (const msg of client.fetch(fresh, { source: true, internalDate: true }, { uid: true })) {
          checked += 1;
          seen.add(String(msg.uid));
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);
          if (parsed.headers.has(OUR_HEADER.toLowerCase())) continue;
          const refs = parsed.references;
          inbound.push({
            from: parsed.from?.value?.[0]?.address ?? parsed.from?.text ?? null,
            to: Array.isArray(parsed.to) ? parsed.to[0]?.text : (parsed.to?.text ?? null),
            subject: parsed.subject ?? "",
            text: parsed.text ?? "",
            messageId: parsed.messageId ?? null,
            inReplyTo: parsed.inReplyTo ?? null,
            references: Array.isArray(refs) ? refs : refs ? [refs] : [],
            receivedAt: (parsed.date ?? (msg.internalDate instanceof Date ? msg.internalDate : new Date())).toISOString(),
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    polling = false;
    await client.logout().catch(() => undefined);
  }
  const results = inbound.map((m) => receiveVendorEmail(ctx, m));
  return { checked, results };
}

/** Test the mailbox login without reading anything. */
export async function verifyInbox(ctx: AppContext): Promise<{ ok: boolean; detail: string }> {
  const url = ctx.config.comms.imapUrl;
  if (!url) return { ok: false, detail: "Set IMAP_URL, or use a Gmail SMTP_URL, so vendor replies can be read" };
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow(connection(url));
  try {
    await client.connect();
    const status = await client.status("INBOX", { messages: true });
    return { ok: true, detail: "Reading " + new URL(url).hostname + " INBOX (" + (status.messages ?? 0) + " messages)" };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Forget which messages were already read (demo reset). */
export function resetInboxCursor() {
  seen.clear();
  lastPoll = 0;
}
