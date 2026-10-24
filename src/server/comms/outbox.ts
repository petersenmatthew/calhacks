import { eq } from "drizzle-orm";
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

function queue(
  ctx: AppContext,
  row: {
    channel: "email" | "slack";
    destination: string;
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
  const inserted = ctx.db
    .insert(outbox)
    .values({
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
