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
}

export type Delivery = { status: "sent"; id: string | null } | { status: "simulated" };

export function emailConfigured(ctx: AppContext) {
  return Boolean(ctx.config.comms.resendApiKey || ctx.config.comms.smtpUrl);
}

export function slackConfigured(ctx: AppContext) {
  return Boolean(ctx.config.comms.slackBotToken || ctx.config.comms.slackWebhookUrl);
}

export async function sendEmail(ctx: AppContext, m: EmailMessage): Promise<Delivery> {
  const c = ctx.config.comms;
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
      attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    return { status: "sent", id: info.messageId ?? null };
  }
  return { status: "simulated" };
}

/** Turn <@handle> into a real Slack mention when the user id is known, else the person's name. */
export function renderMentions(ctx: AppContext, text: string) {
  return text.replace(/<@([a-z]+)>/g, (_, handle: string) => {
    const id = ctx.config.comms.slackUserIds[handle];
    if (id) return "<@" + id + ">";
    return "@" + (PEOPLE.find((p) => p.handle === handle)?.name ?? handle);
  });
}

export async function sendSlack(ctx: AppContext, destination: string, text: string): Promise<Delivery> {
  const c = ctx.config.comms;
  const rendered = renderMentions(ctx, text);
  if (c.slackBotToken) {
    let channel = destination;
    let body = rendered;
    if (destination.startsWith("@")) {
      const id = c.slackUserIds[destination.slice(1)];
      if (id) channel = id;
      else {
        channel = c.slackDmFallbackChannel;
        body = "_(DM for " + renderMentions(ctx, "<@" + destination.slice(1) + ">") + ")_ " + rendered;
      }
    }
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: "Bearer " + c.slackBotToken, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: channel.replace(/^#/, ""), text: body, unfurl_links: false }),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ts?: string };
    if (!json.ok) throw new Error("Slack: " + (json.error ?? res.status));
    return { status: "sent", id: json.ts ?? null };
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
