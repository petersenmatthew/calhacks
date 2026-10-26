import fs from "node:fs";
import path from "node:path";
import { getDefaultModel } from "@openai/agents";
import { createAppContext, DEFAULT_COMMS, type AppContext, type CommsConfig } from "./context";
import { ALL_TABLES, dropGuards, installGuards, migrateIfChanged } from "./db/client";
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

const publicDemo = () => process.env.PUBLIC_DEMO === "1" || process.env.PUBLIC_DEMO === "true";

/** DATABASE_PATH, else data/moa.db; a database from before the rename (data/experiment-ledger.db) is kept in use. */
function databasePath() {
  if (process.env.DATABASE_PATH) return process.env.DATABASE_PATH;
  const legacy = path.join(process.cwd(), "data", "experiment-ledger.db");
  return fs.existsSync(legacy) ? legacy : path.join(process.cwd(), "data", "moa.db");
}

interface Runtime {
  ctx: AppContext;
  orchestrator: Orchestrator;
}

const globalRef = globalThis as unknown as { __moa?: Runtime };

function envMode(): "llm" | "deterministic" | undefined {
  const v = process.env.AGENT_MODE;
  return v === "llm" || v === "deterministic" ? v : undefined;
}

/** The app seeds one demo case; SEED=all loads every case, as the eval does. */
const appSeed = () => (process.env.SEED === "all" ? "all" : "demo");

function createRuntime(file: string): Runtime {
  const llmAvailable = Boolean(process.env.OPENAI_API_KEY);
  const ctx = createAppContext({
    file,
    config: {
      stepDelayMs: Number(process.env.DETERMINISTIC_STEP_DELAY_MS ?? 700),
      llmAvailable,
      model: process.env.OPENAI_MODEL || getDefaultModel(),
      defaultMode: envMode() ?? (llmAvailable ? "llm" : "deterministic"),
      schedulerIntervalMs: process.env.AUTONOMY === "off" ? 0 : Number(process.env.SCHEDULER_INTERVAL_MS ?? 5000),
      feedUrl: process.env.BILLING_FEED_URL || null,
      // A public deployment never sends Slack or email, whatever the environment holds.
      comms: publicDemo() ? { ...DEFAULT_COMMS, appUrl: commsFromEnv().appUrl } : commsFromEnv(),
      publicDemo: publicDemo(),
      maxLlmRunsPerHour: Number(process.env.MAX_LLM_RUNS_PER_HOUR ?? 120),
      defaultRunMode: process.env.RUN_MODE === "all" ? "all" : "one",
    },
  });
  if (!isSeeded(ctx)) seedEnvironment(ctx, appSeed());
  else upgradeEnvironment(ctx);
  const orchestrator = new Orchestrator(ctx);
  if (process.env.NEXT_PHASE !== "phase-production-build") orchestrator.start();
  return { ctx, orchestrator };
}

/** Process-wide singleton: database, event bus, and durable worker. */
export function getRuntime(): Runtime {
  if (!globalRef.__moa) {
    globalRef.__moa = createRuntime(databasePath());
  } else if (process.env.NODE_ENV !== "production" && migrateIfChanged(globalRef.__moa.ctx.db)) {
    // Hot reload brought in a schema change: it is applied above; refresh data that depends on it.
    upgradeEnvironment(globalRef.__moa.ctx);
  }
  return globalRef.__moa;
}

/*
 * Public demo: every visitor gets a sandbox of their own (a separate seeded
 * database, worker and event stream), so two judges never see each other's
 * cases. proxy.ts gives each browser a random sandbox id in a cookie and passes
 * it on the x-moa-sandbox header. Sandboxes idle for SANDBOX_IDLE_MS are
 * stopped and deleted; a returning visitor then starts fresh.
 */
export const SANDBOX_HEADER = "x-moa-sandbox";
const SANDBOX_IDLE_MS = 45 * 60_000;
const MAX_SANDBOXES = 40;
const sandboxRef = globalThis as unknown as { __moaSandboxes?: Map<string, Runtime & { lastSeen: number; file: string }> };

function sandboxDir() {
  return path.join(path.dirname(databasePath()), "sandboxes");
}

function closeSandbox(id: string) {
  const all = sandboxRef.__moaSandboxes!;
  const box = all.get(id);
  if (!box) return;
  all.delete(id);
  box.orchestrator.stop();
  box.ctx.epoch += 1;
  try {
    box.ctx.sqlite.close();
  } catch {
    /* already closed */
  }
  for (const f of [box.file, box.file + "-wal", box.file + "-shm"]) fs.rmSync(f, { force: true });
}

function sweepSandboxes(now: number) {
  const all = sandboxRef.__moaSandboxes!;
  for (const [id, box] of all) if (now - box.lastSeen > SANDBOX_IDLE_MS) closeSandbox(id);
  while (all.size >= MAX_SANDBOXES) {
    const oldest = [...all.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    closeSandbox(oldest[0]);
  }
}

/** The runtime this request should use: the visitor's own sandbox on a public demo, else the shared one. */
export function runtimeFor(request?: Request): Runtime {
  const id = request?.headers.get(SANDBOX_HEADER);
  if (!publicDemo() || !id || !/^[a-z0-9-]{16,64}$/i.test(id)) return getRuntime();
  if (!sandboxRef.__moaSandboxes) {
    sandboxRef.__moaSandboxes = new Map();
    // Files left by a previous process belong to sandboxes nobody can reach any more.
    fs.rmSync(sandboxDir(), { recursive: true, force: true });
  }
  const all = sandboxRef.__moaSandboxes;
  const now = Date.now();
  let box = all.get(id);
  if (!box) {
    sweepSandboxes(now);
    fs.mkdirSync(sandboxDir(), { recursive: true });
    const file = path.join(sandboxDir(), id + ".db");
    box = { ...createRuntime(file), lastSeen: now, file };
    all.set(id, box);
  }
  box.lastSeen = now;
  return box;
}

/** The context this request should use (see runtimeFor). */
export function contextFor(request?: Request) {
  return runtimeFor(request).ctx;
}

export function getContext() {
  return getRuntime().ctx;
}

/** Wipe and reseed the sandbox so the demo can be repeated. */
export async function resetEnvironment(actorId: string, request?: Request) {
  const { ctx, orchestrator } = runtimeFor(request);
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
