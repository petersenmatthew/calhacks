import path from "node:path";
import { getDefaultModel } from "@openai/agents";
import { createAppContext, type AppContext, type CommsConfig } from "./context";
import { ALL_TABLES, dropGuards, installGuards } from "./db/client";
import { PEOPLE } from "./comms/directory";
import { resetInboxCursor } from "./comms/inbox";
import { Orchestrator } from "./orchestrator";
import { authorize, guard } from "./security/authorize";
import { isSeeded, seedEnvironment, upgradeEnvironment } from "./sim/seed";

/**
 * Who is who in Slack. Accepts a member id or username per handle, as
 * "priya=belinda, dana=matthewpetersen", JSON {"priya":"U0123"}, or a single
 * id/username for everyone. Role keys expand: controller, cfo, leads, *.
 */
export function parseUserIds(raw: string | undefined): Record<string, string> {
  const text = (raw ?? "").trim();
  if (!text) return {};
  let pairs: [string, string][] = [];
  if (text.startsWith("{")) {
    try {
      pairs = Object.entries(JSON.parse(text) as Record<string, string>);
    } catch {
      return {};
    }
  } else if (!/[=:]/.test(text)) {
    pairs = [["*", text]];
  } else {
    pairs = text
      .split(/[,;\n]/)
      .map((part) => part.split(/[=:]/).map((x) => x.trim().replace(/^["'@]+|["']+$/g, "")) as [string, string])
      .filter(([k, v]) => k && v);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of pairs) for (const handle of ROLE_KEYS[key.toLowerCase()] ?? [key.toLowerCase()]) out[handle] = value.replace(/^@/, "");
  return out;
}

const ROLE_KEYS: Record<string, string[]> = {
  controller: ["priya"],
  cfo: ["dana"],
  leads: PEOPLE.filter((p) => p.projectId).map((p) => p.handle),
};

/** Gmail uses the same app password for IMAP, so a Gmail SMTP_URL is enough to read replies too. */
function imapFromSmtp(smtpUrl: string | undefined) {
  if (!smtpUrl) return null;
  try {
    const u = new URL(smtpUrl);
    if (u.hostname !== "smtp.gmail.com" || !u.username) return null;
    return "imaps://" + u.username + ":" + u.password + "@imap.gmail.com:993";
  } catch {
    return null;
  }
}

function commsFromEnv(): CommsConfig {
  const env = process.env;
  return {
    appUrl: env.APP_URL || "http://localhost:" + (env.PORT || "3000"),
    vendorEmail: env.VENDOR_EMAIL || null,
    emailFrom: env.EMAIL_FROM || null,
    replyTo: env.EMAIL_REPLY_TO || null,
    resendApiKey: env.RESEND_API_KEY || null,
    smtpUrl: env.SMTP_URL || null,
    imapUrl: env.IMAP_URL || imapFromSmtp(env.SMTP_URL),
    inboxPollMs: Number(env.INBOX_POLL_MS ?? 30_000),
    slackBotToken: env.SLACK_BOT_TOKEN || null,
    slackWebhookUrl: env.SLACK_WEBHOOK_URL || null,
    slackUserIds: { ...parseUserIds(env.SLACK_USER_IDS), ...parseUserIds(env.SLACK_USERS) },
    slackDmFallbackChannel: env.SLACK_DM_FALLBACK_CHANNEL || "finance-ops",
  };
}

interface Runtime {
  ctx: AppContext;
  orchestrator: Orchestrator;
}

const globalRef = globalThis as unknown as { __experimentLedger?: Runtime };

function envMode(): "llm" | "deterministic" | undefined {
  const v = process.env.AGENT_MODE;
  return v === "llm" || v === "deterministic" ? v : undefined;
}

/** The app seeds one demo case; SEED=all loads every case, as the eval does. */
const appSeed = () => (process.env.SEED === "all" ? "all" : "demo");

/** Process-wide singleton: database, event bus, and durable worker. */
export function getRuntime(): Runtime {
  if (!globalRef.__experimentLedger) {
    const llmAvailable = Boolean(process.env.OPENAI_API_KEY);
    const ctx = createAppContext({
      file: process.env.DATABASE_PATH || path.join(process.cwd(), "data", "experiment-ledger.db"),
      config: {
        stepDelayMs: Number(process.env.DETERMINISTIC_STEP_DELAY_MS ?? 700),
        llmAvailable,
        model: process.env.OPENAI_MODEL || getDefaultModel(),
        defaultMode: envMode() ?? (llmAvailable ? "llm" : "deterministic"),
        schedulerIntervalMs: process.env.AUTONOMY === "off" ? 0 : Number(process.env.SCHEDULER_INTERVAL_MS ?? 5000),
        feedUrl: process.env.BILLING_FEED_URL || null,
        comms: commsFromEnv(),
        defaultRunMode: process.env.RUN_MODE === "all" ? "all" : "one",
      },
    });
    if (!isSeeded(ctx)) seedEnvironment(ctx, appSeed());
    else upgradeEnvironment(ctx);
    const orchestrator = new Orchestrator(ctx);
    globalRef.__experimentLedger = { ctx, orchestrator };
    if (process.env.NEXT_PHASE !== "phase-production-build") orchestrator.start();
  }
  return globalRef.__experimentLedger;
}

export function getContext() {
  return getRuntime().ctx;
}

/** Wipe and reseed the sandbox so the demo can be repeated. */
export async function resetEnvironment(actorId: string) {
  const { ctx, orchestrator } = getRuntime();
  guard(ctx, { actorId, action: "environment.reset" }, () => authorize(ctx, actorId, "environment:reset"));
  orchestrator.pause();
  ctx.epoch += 1;
  await orchestrator.waitForIdle(10_000);
  ctx.sqlite.pragma("foreign_keys = OFF");
  dropGuards(ctx.sqlite);
  ctx.sqlite.transaction(() => {
    for (const table of ALL_TABLES) ctx.sqlite.prepare("DELETE FROM " + table).run();
    ctx.sqlite.prepare("DELETE FROM sqlite_sequence").run();
  })();
  installGuards(ctx.sqlite);
  resetInboxCursor();
  seedEnvironment(ctx, appSeed());
  orchestrator.resume();
  ctx.bus.emit("change", "reset");
}
