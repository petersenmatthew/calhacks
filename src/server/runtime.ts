import path from "node:path";
import { getDefaultModel } from "@openai/agents";
import { createAppContext, type AppContext } from "./context";
import { ALL_TABLES, dropGuards, installGuards } from "./db/client";
import { Orchestrator } from "./orchestrator";
import { authorize, guard } from "./security/authorize";
import { ensureActors, isSeeded, seedEnvironment } from "./sim/seed";

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
        defaultRunMode: process.env.RUN_MODE === "all" ? "all" : "one",
      },
    });
    if (!isSeeded(ctx)) seedEnvironment(ctx, appSeed());
    else ensureActors(ctx);
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
  seedEnvironment(ctx, appSeed());
  orchestrator.resume();
  ctx.bus.emit("change", "reset");
}
