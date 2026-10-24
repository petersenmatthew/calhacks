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
      // Vendor replies carry the case reference (e.g. LAMBDA-CASE-6001; matchDispute does the exact match).
      // Bounces come from the mail system with their own subject, so look for those too.
      const uids = (await client.search({ since, or: [{ subject: "CASE" }, { from: "mailer-daemon" }, { from: "postmaster" }] }, { uid: true })) || [];
      const fresh = uids.filter((uid) => !seen.has(String(uid)));
      if (fresh.length) {
        for await (const msg of client.fetch(fresh, { source: true, internalDate: true }, { uid: true })) {
          checked += 1;
          seen.add(String(msg.uid));
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);
          if (parsed.headers.has(OUR_HEADER.toLowerCase())) continue;
          const refs = parsed.references;
          const from = parsed.from?.value?.[0]?.address ?? parsed.from?.text ?? null;
          const header = (name: string) => String(parsed.headers.get(name) ?? "").toLowerCase();
          const attachments = (parsed.attachments ?? []).filter((a) => a.contentDisposition !== "inline" || a.filename);
          const body = parsed.text?.trim() || htmlToText(typeof parsed.html === "string" ? parsed.html : "");
          inbound.push({
            from,
            to: Array.isArray(parsed.to) ? parsed.to[0]?.text : (parsed.to?.text ?? null),
            subject: parsed.subject ?? "",
            text:
              body +
              (attachments.length
                ? "\n\n[Attached: " + attachments.map((a) => (a.filename ?? "file") + " (" + Math.max(1, Math.round(a.size / 1024)) + " KB)").join(", ") + "]"
                : ""),
            kind: isBounce(from, parsed.subject ?? "", header("content-type")) ? "bounce" : isAutomated(header, parsed.subject ?? "") ? "auto_reply" : "reply",
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

/** The mail system telling us a letter could not be delivered. */
export function isBounce(from: string | null, subject: string, contentType: string) {
  return (
    /^(mailer-daemon|postmaster)@/i.test(from ?? "") ||
    contentType.includes("report-type=delivery-status") ||
    /^(delivery status notification|undeliver(ed|able)|mail delivery (failed|subsystem)|returned mail)/i.test(subject)
  );
}

/** Out-of-office and other machine-written replies (RFC 3834 and the common vendor headers). */
export function isAutomated(header: (name: string) => string, subject: string) {
  const auto = header("auto-submitted");
  return (
    (auto !== "" && auto !== "no") ||
    header("x-autoreply") !== "" ||
    header("x-autorespond") !== "" ||
    /^(bulk|junk|list|auto_reply)$/.test(header("precedence")) ||
    /^(auto(matic)?[ -]?reply|out of (the )?office|autoreply|away from)/i.test(subject.replace(/^(re|fwd?):\s*/i, ""))
  );
}

function htmlToText(html: string) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
