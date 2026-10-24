import path from "node:path";
import { getDefaultModel } from "@openai/agents";
import { createAppContext, type AppContext, type CommsConfig } from "./context";
import { ALL_TABLES, dropGuards, installGuards } from "./db/client";
import { Orchestrator } from "./orchestrator";
import { authorize, guard } from "./security/authorize";
import { isSeeded, seedEnvironment, upgradeEnvironment } from "./sim/seed";

function parseUserIds(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
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
    slackBotToken: env.SLACK_BOT_TOKEN || null,
    slackWebhookUrl: env.SLACK_WEBHOOK_URL || null,
    slackUserIds: parseUserIds(env.SLACK_USER_IDS),
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
      },
    });
    if (!isSeeded(ctx)) seedEnvironment(ctx);
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
  seedEnvironment(ctx);
  orchestrator.resume();
  ctx.bus.emit("change", "reset");
}
