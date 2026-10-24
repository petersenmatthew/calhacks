import type { AppContext } from "../context";
import { PEOPLE } from "./directory";

/*
 * Delivery. Email goes through Resend (RESEND_API_KEY) or any SMTP server
 * (SMTP_URL, e.g. a Gmail app password). Slack goes through a bot token
 * (SLACK_BOT_TOKEN) or an incoming webhook (SLACK_WEBHOOK_URL). With none
 * configured, messages are kept in the outbox and shown in the app as
 * "simulated", so the demo works offline.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  attachments: { filename: string; content: string; contentType: string }[];
  /** Extra headers, e.g. In-Reply-To and References so a reply stays in the vendor's thread. */
  headers?: Record<string, string> | null;
}

/** Set on every email we send, so the inbox poller never mistakes our own letters for vendor replies. */
export const OUR_HEADER = "X-Atlas-Outbox";

export type Delivery = { status: "sent"; id: string | null } | { status: "simulated" };

export function emailConfigured(ctx: AppContext) {
  return Boolean(ctx.config.comms.resendApiKey || ctx.config.comms.smtpUrl);
}

export function slackConfigured(ctx: AppContext) {
  return Boolean(ctx.config.comms.slackBotToken || ctx.config.comms.slackWebhookUrl);
}

export async function sendEmail(ctx: AppContext, m: EmailMessage): Promise<Delivery> {
  const c = ctx.config.comms;
  const headers = { ...(m.headers ?? {}), [OUR_HEADER]: "1" };
  if (c.resendApiKey) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + c.resendApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: c.emailFrom || "Atlas Research Accounts Payable <onboarding@resend.dev>",
        to: [m.to],
        subject: m.subject,
        text: m.text,
        ...(m.html ? { html: m.html } : {}),
        ...(c.replyTo ? { reply_to: c.replyTo } : {}),
        headers,
        attachments: m.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64") })),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) throw new Error("Resend " + res.status + ": " + (body.message ?? res.statusText));
    return { status: "sent", id: body.id ?? null };
  }
  if (c.smtpUrl) {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport(c.smtpUrl);
    const from = c.emailFrom || "Atlas Research Accounts Payable <" + decodeURIComponent(new URL(c.smtpUrl).username) + ">";
    const info = await transport.sendMail({
      from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      ...(m.html ? { html: m.html } : {}),
      ...(c.replyTo ? { replyTo: c.replyTo } : {}),
      headers,
      attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return { status: "sent", id: info.messageId ?? null };
  }
  return { status: "simulated" };
}

const resolvedUsers = new Map<string, string>();
let usersLoaded = false;

const isMemberId = (v: string) => /^[UW][A-Z0-9]{6,}$/.test(v);

/** Slack member id for a handle, once resolveSlackUsers has run (ids configured directly work without it). */
export function slackUserId(ctx: AppContext, handle: string) {
  const ids = ctx.config.comms.slackUserIds;
  const raw = ids[handle] ?? ids["*"];
  if (!raw) return null;
  if (isMemberId(raw)) return raw;
  return resolvedUsers.get(raw.toLowerCase()) ?? null;
}

/**
 * Turn usernames in SLACK_USERS (e.g. "belinda") into member ids with
 * users.list (needs the users:read scope). Matches the username, display name,
 * or full name, case-insensitively. Cached for the life of the process.
 */
export async function resolveSlackUsers(ctx: AppContext, force = false) {
  const names = [...new Set(Object.values(ctx.config.comms.slackUserIds))].filter((v) => !isMemberId(v)).map((v) => v.toLowerCase());
  if (!names.length || !ctx.config.comms.slackBotToken || (usersLoaded && !force && names.every((n) => resolvedUsers.has(n)))) return resolvedUsers;
  let cursor: string | undefined;
  do {
    const { json } = await slackApi(ctx, "users.list", { limit: 500, cursor });
    for (const u of (json.members as { id: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; profile?: { display_name?: string; real_name?: string } }[]) ?? []) {
      if (u.deleted || u.is_bot) continue;
      for (const n of [u.name, u.real_name, u.profile?.display_name, u.profile?.real_name]) {
        const key = (n ?? "").trim().toLowerCase();
        if (key && !resolvedUsers.has(key)) resolvedUsers.set(key, u.id);
      }
    }
    cursor = (json.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
  } while (cursor);
  usersLoaded = true;
  return resolvedUsers;
}

/** Each configured handle with the Slack user it resolved to, for the diagnostics page. */
export function slackUserMap(ctx: AppContext) {
  const out: Record<string, string> = {};
  for (const [handle, raw] of Object.entries(ctx.config.comms.slackUserIds)) out[handle] = raw + " -> " + (slackUserId(ctx, handle) ?? "not found");
  return out;
}

/** Turn <@handle> into a real Slack mention when the user id is known, else the person's name. */
export function renderMentions(ctx: AppContext, text: string) {
  return text.replace(/<@([a-z]+)>/g, (_, handle: string) => {
    const id = slackUserId(ctx, handle);
    if (id) return "<@" + id + ">";
    return "@" + (PEOPLE.find((p) => p.handle === handle)?.name ?? handle);
  });
}

export class SlackError extends Error {
  constructor(
    public code: string,
    public needed?: string,
  ) {
    super(
      code === "missing_scope"
        ? "Slack app is missing the " + needed + " scope. Add it under OAuth & Permissions, then reinstall the app."
        : code === "invalid_auth" || code === "not_authed"
          ? "SLACK_BOT_TOKEN is not valid for any workspace. Copy the Bot User OAuth Token (xoxb-...) again."
          : code === "not_in_channel"
            ? "The bot is not in that channel. Add the chat:write.public scope, or /invite @Ledger in the channel."
            : "Slack: " + code,
    );
  }
}

/** Call a Slack Web API method with the bot token. Returns the parsed body and the token's scopes. */
export async function slackApi(ctx: AppContext, method: string, body: Record<string, unknown> = {}) {
  const res = await fetch("https://slack.com/api/" + method, {
    method: "POST",
    headers: { Authorization: "Bearer " + ctx.config.comms.slackBotToken, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { ok?: boolean; error?: string; needed?: string };
  if (!json.ok) throw new SlackError(json.error ?? "http_" + res.status, json.needed);
  return { json, scopes: (res.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean) };
}

const channelIds = new Map<string, string>();

/**
 * Find a channel's id by name, creating it if it does not exist yet (needs
 * channels:read and channels:manage), and make sure the bot is in it.
 */
export async function resolveSlackChannel(ctx: AppContext, name: string, create = true): Promise<{ id: string; created: boolean }> {
  const clean = name.replace(/^#/, "");
  if (/^[CG][A-Z0-9]{6,}$/.test(clean)) return { id: clean, created: false };
  const cached = channelIds.get(clean);
  if (cached) {
    await inviteTeam(ctx, cached);
    return { id: cached, created: false };
  }
  let cursor: string | undefined;
  do {
    const { json } = await slackApi(ctx, "conversations.list", { types: "public_channel,private_channel", exclude_archived: true, limit: 1000, cursor });
    for (const ch of (json.channels as { id: string; name: string; is_member?: boolean }[]) ?? []) {
      channelIds.set(ch.name, ch.id);
      if (ch.name === clean && !ch.is_member) {
        await slackApi(ctx, "conversations.join", { channel: ch.id }).catch(() => undefined);
      }
    }
    cursor = (json.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
  } while (cursor && !channelIds.has(clean));
  const found = channelIds.get(clean);
  if (found) {
    await inviteTeam(ctx, found);
    return { id: found, created: false };
  }
  if (!create) throw new SlackError("channel_not_found");
  const { json } = await slackApi(ctx, "conversations.create", { name: clean });
  const id = (json.channel as { id: string }).id;
  channelIds.set(clean, id);
  await inviteTeam(ctx, id);
  return { id, created: true };
}

const invited = new Set<string>();

/** Add the people in SLACK_USER_IDS to a channel the bot uses (once per channel per process), so it shows in their sidebar. */
async function inviteTeam(ctx: AppContext, channel: string) {
  await resolveSlackUsers(ctx);
  const people = [...new Set(Object.keys(ctx.config.comms.slackUserIds).map((h) => slackUserId(ctx, h)).filter((x): x is string => Boolean(x)))];
  if (!people.length || invited.has(channel)) return;
  invited.add(channel);
  // already_in_channel and similar are fine; the post itself does not depend on this.
  await slackApi(ctx, "conversations.invite", { channel, users: people.join(",") }).catch(() => undefined);
}

export async function sendSlack(ctx: AppContext, destination: string, text: string): Promise<Delivery> {
  const c = ctx.config.comms;
  if (c.slackBotToken) await resolveSlackUsers(ctx);
  const rendered = renderMentions(ctx, text);
  if (c.slackBotToken) {
    let channel: string;
    let body = rendered;
    if (destination.startsWith("@")) {
      const id = slackUserId(ctx, destination.slice(1));
      if (id) channel = id;
      else {
        channel = (await resolveSlackChannel(ctx, c.slackDmFallbackChannel)).id;
        body = "_(DM for " + renderMentions(ctx, "<@" + destination.slice(1) + ">") + ")_ " + rendered;
      }
    } else {
      channel = (await resolveSlackChannel(ctx, destination)).id;
    }
    const { json } = await slackApi(ctx, "chat.postMessage", { channel, text: body, unfurl_links: false });
    return { status: "sent", id: (json.ts as string) ?? null };
  }
  if (c.slackWebhookUrl) {
    const res = await fetch(c.slackWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "*" + destination + "*  " + rendered }),
    });
    if (!res.ok) throw new Error("Slack webhook " + res.status);
    return { status: "sent", id: null };
  }
  return { status: "simulated" };
}

/** Check the mail server connection and login without sending anything. */
export async function verifyEmail(ctx: AppContext): Promise<{ mode: string; ok: boolean; detail: string }> {
  const c = ctx.config.comms;
  if (c.smtpUrl) {
    try {
      const nodemailer = await import("nodemailer");
      await nodemailer.createTransport(c.smtpUrl).verify();
      return { mode: "smtp", ok: true, detail: "Logged in to " + new URL(c.smtpUrl).hostname };
    } catch (e) {
      return { mode: "smtp", ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
  if (c.resendApiKey) return { mode: "resend", ok: true, detail: "Resend key set (checked on first send)" };
  return { mode: "none", ok: false, detail: "Set SMTP_URL or RESEND_API_KEY in .env.local" };
}

/** Forget cached channel and user ids (tests, or after changing Slack settings). */
export function resetSlackCache() {
  channelIds.clear();
  invited.clear();
  resolvedUsers.clear();
  usersLoaded = false;
}
