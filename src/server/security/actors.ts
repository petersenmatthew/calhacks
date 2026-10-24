import { eq } from "drizzle-orm";
import type { AppContext } from "../context";
import { actors } from "../db/schema";

export type ActorRow = typeof actors.$inferSelect;

export const ACTOR = {
  compute: "agent.compute",
  finance: "agent.finance",
  controller: "human.controller",
  cfo: "human.cfo",
  scheduler: "system.scheduler",
  orchestrator: "system.orchestrator",
  ingestion: "system.ingestion",
  erp: "system.erp",
  ledger: "system.ledger_gateway",
  vendor: "system.vendor_portal",
  simulator: "system.simulator",
} as const;

export const ACTOR_SEED: ActorRow[] = [
  {
    id: ACTOR.compute,
    name: "Compute Agent",
    kind: "agent",
    role: "compute_agent",
    title: "Compute cost investigator",
    description: "Investigates GPU jobs, instance lifecycles, provider meters, reservations, and billing terms.",
  },
  {
    id: ACTOR.finance,
    name: "Finance Agent",
    kind: "agent",
    role: "finance_agent",
    title: "Research cost accountant",
    description: "Applies accounting policy, prepares allocations and disputes, and proposes adjustments.",
  },
  {
    id: ACTOR.controller,
    name: "Priya Natarajan",
    kind: "human",
    role: "controller",
    title: "Controller",
    description: "Approves financial adjustments, vendor disputes, and accounting policies.",
  },
  {
    id: ACTOR.cfo,
    name: "Dana Whitfield",
    kind: "human",
    role: "controller",
    title: "CFO (backup approver)",
    description: "Backup approver. Receives escalations when an approval waits too long.",
  },
  {
    id: ACTOR.scheduler,
    name: "Scheduler",
    kind: "system",
    role: "scheduler",
    title: "Autonomy scheduler",
    description: "Syncs provider billing feeds on a cursor and runs time-based follow-ups (reminders, escalations, vendor chases).",
  },
  {
    id: ACTOR.orchestrator,
    name: "Orchestrator",
    kind: "system",
    role: "orchestrator",
    title: "Workflow engine",
    description: "Schedules agent work, enforces state transitions, and resumes workflows.",
  },
  {
    id: ACTOR.ingestion,
    name: "Billing ingestion",
    kind: "system",
    role: "ingestion",
    title: "Provider billing feed",
    description: "Receives provider invoice lines and runs deterministic reconciliation checks.",
  },
  {
    id: ACTOR.erp,
    name: "ERP AP subledger",
    kind: "system",
    role: "erp",
    title: "Simulated ERP",
    description: "Records vendor invoices as accounts payable (simulated system of record).",
  },
  {
    id: ACTOR.ledger,
    name: "Ledger gateway",
    kind: "system",
    role: "ledger_gateway",
    title: "Authorized posting service",
    description: "The only actor allowed to post journal entries or submit disputes, and only with a valid approval or policy.",
  },
  {
    id: ACTOR.vendor,
    name: "Vendor portal",
    kind: "system",
    role: "vendor_portal",
    title: "Simulated provider portal",
    description: "Receives disputes and returns vendor responses (simulated).",
  },
  {
    id: ACTOR.simulator,
    name: "Demo simulator",
    kind: "system",
    role: "simulator",
    title: "Simulated source systems",
    description: "Writes simulated scheduler, infrastructure, tracker, and provider records for demo scenarios.",
  },
];

const cache = new WeakMap<AppContext, Map<string, ActorRow>>();

export function getActor(ctx: AppContext, id: string): ActorRow | undefined {
  let map = cache.get(ctx);
  if (!map) {
    map = new Map();
    cache.set(ctx, map);
  }
  const hit = map.get(id);
  if (hit) return hit;
  const row = ctx.db.select().from(actors).where(eq(actors.id, id)).get();
  if (row) map.set(id, row);
  return row;
}
