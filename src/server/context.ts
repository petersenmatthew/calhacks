import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import { openDatabase, type DB } from "./db/client";

export interface AppConfig {
  /** Pause between deterministic agent steps so the live timeline is watchable. */
  stepDelayMs: number;
  /** True when OPENAI_API_KEY is configured. */
  llmAvailable: boolean;
  /** Model used for LLM agents. */
  model: string;
  /** Default execution mode when nothing is stored in settings. */
  defaultMode: "llm" | "deterministic";
  /** How often the scheduler syncs feeds and runs follow-ups. 0 disables it. */
  schedulerIntervalMs: number;
  /** Optional external billing feed polled by the scheduler. */
  feedUrl: string | null;
  /** Email and Slack delivery. Empty values mean messages stay in the outbox as "simulated". */
  comms: CommsConfig;
}

export interface CommsConfig {
  appUrl: string;
  vendorEmail: string | null;
  emailFrom: string | null;
  replyTo: string | null;
  resendApiKey: string | null;
  smtpUrl: string | null;
  slackBotToken: string | null;
  slackWebhookUrl: string | null;
  slackUserIds: Record<string, string>;
  slackDmFallbackChannel: string;
}

export const DEFAULT_COMMS: CommsConfig = {
  appUrl: "http://localhost:3000",
  vendorEmail: null,
  emailFrom: null,
  replyTo: null,
  resendApiKey: null,
  smtpUrl: null,
  slackBotToken: null,
  slackWebhookUrl: null,
  slackUserIds: {},
  slackDmFallbackChannel: "finance-ops",
};

export interface AppContext {
  sqlite: Database.Database;
  db: DB;
  bus: EventEmitter;
  config: AppConfig;
  /** Incremented on demo reset; in-flight agent runs from an older epoch abort. */
  epoch: number;
  /** While set, activity events are buffered so a tool's own event is logged before its side effects. */
  deferredActivity: unknown[] | null;
}

export function createAppContext(options: { file: string; config?: Partial<AppConfig> }): AppContext {
  const { sqlite, db } = openDatabase(options.file);
  const bus = new EventEmitter();
  bus.setMaxListeners(500);
  const llmAvailable = options.config?.llmAvailable ?? false;
  return {
    sqlite,
    db,
    bus,
    epoch: 0,
    deferredActivity: null,
    config: {
      stepDelayMs: options.config?.stepDelayMs ?? 0,
      llmAvailable,
      model: options.config?.model ?? "gpt-5.6-luna",
      defaultMode: options.config?.defaultMode ?? (llmAvailable ? "llm" : "deterministic"),
      schedulerIntervalMs: options.config?.schedulerIntervalMs ?? 0,
      feedUrl: options.config?.feedUrl ?? null,
      comms: { ...DEFAULT_COMMS, ...(options.config?.comms ?? {}) },
    },
  };
}

/** Runs fn inside a SQLite transaction (nested calls become savepoints). */
export function tx<T>(ctx: AppContext, fn: () => T): T {
  return ctx.sqlite.transaction(fn)();
}

/** BEGIN IMMEDIATE transaction, used for queue claims. */
export function txImmediate<T>(ctx: AppContext, fn: () => T): T {
  return ctx.sqlite.transaction(fn).immediate();
}

export function nowIso() {
  return new Date().toISOString();
}

/** Sequential human-readable identifiers, e.g. WI-1001. */
export function nextId(ctx: AppContext, prefix: string, start = 1001): string {
  const row = ctx.sqlite
    .prepare(
      "INSERT INTO counters(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value",
    )
    .get(prefix, start) as { value: number };
  return prefix + "-" + row.value;
}

/** Notify live listeners after the current synchronous transaction finishes. */
export function notifyChange(ctx: AppContext, topic: string) {
  setImmediate(() => ctx.bus.emit("change", topic));
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
