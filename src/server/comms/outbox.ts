import { and, desc, eq } from "drizzle-orm";
import { notifyChange, nowIso, type AppContext } from "../context";
import { outbox, providers } from "../db/schema";
import { CONTROLLER, type ChannelName } from "./directory";

/*
 * Messages are written to the outbox inside the same transaction as the
 * action that caused them, and delivered later by the dispatcher. Text uses
 * Slack's own markup: <@handle> for a mention and <url|label> for a link.
 */

export function appUrl(ctx: AppContext, path: string) {
  return ctx.config.comms.appUrl.replace(/\/$/, "") + path;
}

export function taskLink(ctx: AppContext, workItemId: string | null | undefined) {
  if (!workItemId || workItemId === "ONBOARDING") return "<" + appUrl(ctx, "/canvas") + "|Open canvas>";
  return "<" + appUrl(ctx, "/investigations/" + workItemId) + "|" + workItemId + ">";
}

export function mention(handle: string) {
  return "<@" + handle + ">";
}

export function postSlack(
  ctx: AppContext,
  input: { channel: ChannelName; text: string; event: string; workItemId?: string | null; ref?: string | null; mentions?: string[] },
) {
  return queue(ctx, { channel: "slack", destination: "#" + input.channel, body: input.text, event: input.event, workItemId: input.workItemId, ref: input.ref, mentions: input.mentions ?? [] });
}

/** A direct message to one person. */
export function dmSlack(ctx: AppContext, input: { to: string; text: string; event: string; workItemId?: string | null; ref?: string | null }) {
  return queue(ctx, { channel: "slack", destination: "@" + input.to, body: input.text, event: input.event, workItemId: input.workItemId, ref: input.ref, mentions: [input.to] });
}

export function queueEmail(
  ctx: AppContext,
  input: {
    to: string;
    subject: string;
    text: string;
    html?: string | null;
    event: string;
    workItemId?: string | null;
    ref?: string | null;
    attachments?: { filename: string; content: string; contentType: string }[];
    headers?: Record<string, string> | null;
  },
) {
  return queue(ctx, {
    headers: input.headers ?? null,
    channel: "email",
    destination: input.to,
    subject: input.subject,
    body: input.text,
    html: input.html ?? null,
    attachments: input.attachments ?? [],
    event: input.event,
    workItemId: input.workItemId,
    ref: input.ref,
    mentions: [],
  });
}

/*
 * Slack threads. Follow-up messages about one approval or one dispute go in
 * the thread of the message that started it, so a channel reads as one line
 * per case. Keyed by event; the parent shares the same ref (approval or
 * dispute id) and channel. Events marked broadcast also show in the channel.
 */
const THREAD_UNDER: Record<string, { parent: string; broadcast?: boolean }> = {
  "approval.escalated": { parent: "approval.requested" },
  "approval.decided": { parent: "approval.requested" },
  "dispute.vendor_message": { parent: "dispute.sent" },
  "dispute.reply_sent": { parent: "dispute.sent" },
  "dispute.controller_question": { parent: "dispute.sent" },
  "dispute.follow_up": { parent: "dispute.sent" },
  "dispute.escalated": { parent: "dispute.sent" },
  "dispute.reply": { parent: "dispute.sent" },
  "dispute.bounced": { parent: "dispute.sent", broadcast: true },
  "dispute.closed": { parent: "dispute.sent", broadcast: true },
};

function parentRow(ctx: AppContext, event: string, ref: string | null | undefined, destination?: string) {
  if (!ref) return null;
  return (
    ctx.db
      .select({ id: outbox.id })
      .from(outbox)
      .where(and(eq(outbox.channel, "slack"), eq(outbox.event, event), eq(outbox.ref, ref), ...(destination ? [eq(outbox.destination, destination)] : [])))
      .orderBy(desc(outbox.id))
      .get() ?? null
  );
}

/**
 * React to the Slack message that started something, e.g. a check mark on the
 * approval request once it is approved, so the channel shows status at a glance.
 * Delivered after the message itself; a no-op when that message was never posted.
 */
export function reactSlack(ctx: AppContext, input: { on: { event: string; ref: string }; emoji: string; event: string; workItemId?: string | null }) {
  const parent = parentRow(ctx, input.on.event, input.on.ref);
  if (!parent) return null;
  return queue(ctx, {
    channel: "slack_reaction",
    destination: "reaction",
    body: input.emoji,
    event: input.event,
    workItemId: input.workItemId,
    ref: input.on.ref,
    mentions: [],
    threadOf: parent.id,
  });
}

function queue(
  ctx: AppContext,
  row: {
    channel: "email" | "slack" | "slack_reaction";
    destination: string;
    threadOf?: number | null;
    body: string;
    event: string;
    subject?: string | null;
    html?: string | null;
    attachments?: { filename: string; content: string; contentType: string }[];
    headers?: Record<string, string> | null;
    workItemId?: string | null;
    ref?: string | null;
    mentions: string[];
  },
) {
  let threadOf = row.threadOf ?? null;
  let broadcast = false;
  const rule = row.channel === "slack" && row.destination.startsWith("#") ? THREAD_UNDER[row.event] : undefined;
  if (rule && threadOf === null) {
    threadOf = parentRow(ctx, rule.parent, row.ref, row.destination)?.id ?? null;
    broadcast = Boolean(rule.broadcast && threadOf);
  }
  const inserted = ctx.db
    .insert(outbox)
    .values({
      threadOf,
      broadcast,
      channel: row.channel,
      destination: row.destination,
      subject: row.subject ?? null,
      body: row.body,
      html: row.html ?? null,
      mentions: row.mentions,
      attachments: row.attachments ?? [],
      headers: row.headers ?? null,
      event: row.event,
      workItemId: row.workItemId ?? null,
      ref: row.ref ?? null,
      status: "pending",
      createdAt: nowIso(),
    })
    .returning({ id: outbox.id })
    .get();
  notifyChange(ctx, "outbox");
  return inserted.id;
}

/** Where a provider's disputes are emailed. VENDOR_EMAIL overrides every provider (demo inbox). */
export function vendorEmail(ctx: AppContext, providerId: string) {
  if (ctx.config.comms.vendorEmail) return ctx.config.comms.vendorEmail;
  const p = ctx.db.select().from(providers).where(eq(providers.id, providerId)).get();
  return p?.billingEmail ?? "billing@" + (p?.shortName ?? "vendor").toLowerCase() + ".example";
}

export { CONTROLLER };
