import { Agent, run } from "@openai/agents";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../context";
import { providers, vendorDisputes } from "../db/schema";
import { formatCents } from "../domain/money";
import { getExecutionMode } from "../settings";
import { takeLiveModelRun } from "../agents/runner";
import { disputeThread, receiveVendorEmail, type DisputeRow } from "./vendor-replies";

/*
 * A stand-in for the cloud provider's billing team, for when no real mailbox is
 * connected (always on the public demo). A few seconds after a dispute or a
 * Vendor Liaison answer goes out, a model playing the provider writes back, and
 * the reply goes through receiveVendorEmail exactly like a real email, so the
 * Vendor Liaison reads and handles it the same way.
 *
 * MOCK_VENDOR=on|off forces it (default: on when no email transport is set).
 * MOCK_VENDOR_OUTCOME=credit|partial|evidence|random picks the first reply's stance (default random).
 * MOCK_VENDOR_DELAY_MS sets the wait before replying (default 6000).
 */

type Stance = "credit" | "partial" | "evidence";

/** Replies per dispute before the mock vendor always settles, so a demo conversation ends. */
const MAX_REPLIES = 3;

export function mockVendorEnabled(ctx: AppContext) {
  const flag = (process.env.MOCK_VENDOR ?? "").toLowerCase();
  if (flag === "on" || flag === "1" || flag === "true") return true;
  if (flag === "off" || flag === "0" || flag === "false") return false;
  return !ctx.config.comms.resendApiKey && !ctx.config.comms.smtpUrl;
}

const delayMs = () => Number(process.env.MOCK_VENDOR_DELAY_MS ?? 6000);

/** One reply in flight per dispute, per sandbox. */
const inFlight = new WeakMap<AppContext, Set<string>>();

function firstStance(): Stance {
  const v = (process.env.MOCK_VENDOR_OUTCOME ?? "").toLowerCase();
  if (v === "credit" || v === "partial" || v === "evidence") return v;
  const r = Math.random();
  return r < 0.5 ? "credit" : r < 0.75 ? "evidence" : "partial";
}

/** A round partial offer: three quarters of the disputed amount. */
function partialCents(amount: number) {
  const p = Math.round(amount * 0.75);
  return amount >= 40_000 ? Math.round(p / 10_000) * 10_000 : p;
}

function memoFor(dispute: DisputeRow) {
  const n = Number(dispute.id.replace(/\D/g, "")) || 1;
  return "CM-" + (1000 + (n % 9000));
}

function template(stance: Stance, d: { ref: string; line: string; amount: string; partial: string; memo: string; vendor: string; instance: string }) {
  const sign = "\n\n" + d.vendor + " Billing Team";
  if (stance === "credit") {
    return (
      "Hi,\n\nThanks for the detailed evidence on " + d.ref + ". We reviewed our records for " + d.instance + " and agree the disputed charge on line " + d.line +
      " was not supported.\n\nWe've issued credit memo " + d.memo + " for " + d.amount + ". It will show on your next statement." + sign
    );
  }
  if (stance === "partial") {
    return (
      "Hi,\n\nWe've reviewed " + d.ref + ". Part of the disputed time on line " + d.line + " covers storage that stayed allocated after shutdown while a snapshot completed, which is billable.\n\n" +
      "We can offer a credit of " + d.partial + " to settle this. Please confirm and we'll issue the credit memo." + sign
    );
  }
  return (
    "Hi,\n\nWe're reviewing " + d.ref + ". Before we can credit line " + d.line + ", we need to rule out " + d.instance +
    " having been restarted from your side after the stop request.\n\nCould you send your scheduler or job logs for the disputed window showing nothing ran?" + sign
  );
}

async function write(ctx: AppContext, stance: Stance, thread: string, facts: ReturnType<typeof factsFor>): Promise<string> {
  const fallback = template(stance, facts);
  if (!ctx.config.llmAvailable || getExecutionMode(ctx) !== "llm" || !takeLiveModelRun(ctx)) return fallback;
  const must =
    stance === "credit"
      ? "Grant the full credit: state credit memo " + facts.memo + " for exactly " + facts.amount + "."
      : stance === "partial"
        ? "Offer a partial credit of exactly " + facts.partial + " (not the full " + facts.amount + "), with a short, plausible billing reason, and ask them to confirm. Do not issue a memo yet."
        : "Do not credit yet. Ask for one specific piece of evidence a billing team would need (for example their job logs for the disputed window). Write no dollar amounts.";
  try {
    const agent = new Agent({
      name: facts.vendor + " Billing",
      model: ctx.config.model,
      instructions:
        "You are the billing team at " + facts.vendor + ", a GPU cloud, answering a customer's billing dispute by email. " +
        "Write only the email body: plain text, under 120 words, polite and businesslike, signed '" + facts.vendor + " Billing Team'. " +
        "Quote the case reference " + facts.ref + ". " + must + " Never invent other amounts.",
    });
    const result = await run(agent, "The conversation so far, oldest first:\n\n" + thread + "\n\nWrite your reply.", { maxTurns: 1 });
    const text = String(result.finalOutput ?? "").trim();
    // The reply must carry the exact figures the Vendor Liaison will check; otherwise use the template.
    if (stance === "credit" && !(text.includes(facts.amount) && text.includes(facts.memo))) return fallback;
    if (stance === "partial" && !text.includes(facts.partial)) return fallback;
    return text.length > 20 ? text.slice(0, 3000) : fallback;
  } catch {
    return fallback;
  }
}

function factsFor(ctx: AppContext, dispute: DisputeRow) {
  const vendor = ctx.db.select().from(providers).where(eq(providers.id, dispute.providerId)).get()?.name ?? "The provider";
  const instance = /instance ([a-z0-9-]+)/i.exec(dispute.letterBody ?? "")?.[1] ?? "the instance";
  return {
    ref: dispute.vendorReference ?? dispute.id,
    line: dispute.invoiceLineId,
    amount: formatCents(dispute.amountCents),
    partial: formatCents(partialCents(dispute.amountCents)),
    memo: memoFor(dispute),
    vendor,
    instance,
  };
}

/** Called on every scheduler tick: answer any dispute whose last message is ours and old enough. */
export async function runMockVendor(ctx: AppContext) {
  if (!mockVendorEnabled(ctx)) return 0;
  const busy = inFlight.get(ctx) ?? new Set<string>();
  inFlight.set(ctx, busy);
  const open = ctx.db.select().from(vendorDisputes).where(and(eq(vendorDisputes.status, "SUBMITTED"))).all();
  let sent = 0;
  for (const dispute of open) {
    if (busy.has(dispute.id) || dispute.emailStatus === "bounced") continue;
    const thread = disputeThread(ctx, dispute);
    const last = thread.at(-1);
    if (!last || last.direction !== "outbound") continue;
    if (Date.now() - new Date(last.at).getTime() < delayMs()) continue;
    const replies = thread.filter((e) => e.direction === "inbound").length;
    if (replies >= MAX_REPLIES) continue;
    // First answer varies; after the customer responds, the provider settles in full.
    const stance: Stance = replies === 0 ? firstStance() : "credit";
    const epoch = ctx.epoch;
    busy.add(dispute.id);
    try {
      const facts = factsFor(ctx, dispute);
      const text = await write(
        ctx,
        stance,
        thread.map((e) => (e.direction === "outbound" ? "Customer (" + (e.from ?? "AP") + "):\n" : facts.vendor + ":\n") + e.body).join("\n\n---\n\n"),
        facts,
      );
      // A demo reset while the model was writing: drop the reply.
      if (ctx.epoch !== epoch) continue;
      receiveVendorEmail(ctx, {
        from: facts.vendor + " Billing (simulated) <" + (dispute.sentTo ?? "billing@vendor.example") + ">",
        subject: "Re: " + (dispute.letterSubject ?? dispute.id),
        text,
        messageId: "<mock-" + dispute.id + "-" + (replies + 1) + "@vendor.simulated>",
      });
      sent++;
    } finally {
      busy.delete(dispute.id);
    }
  }
  return sent;
}
