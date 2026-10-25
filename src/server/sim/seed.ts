import { and, eq, isNull } from "drizzle-orm";
import type { AppContext } from "../context";
import { tx } from "../context";
import { appendAudit } from "../audit";
import { recordActivity } from "../activity";
import {
  actors,
  contracts,
  ledgerAccounts,
  policies,
  precedents,
  projects,
  providers,
  type ContractClause,
} from "../db/schema";
import { ACTOR, ACTOR_SEED, controllerName } from "../security/actors";
import { ingestCase } from "./scenarios";
import { SEED_CASES } from "./cases";
import { seedFeedSchedule } from "./feed-schedule";
import { seedApHistory } from "./history";
import { scheduleOnboarding } from "../workflow/onboarding";

export const PROJECTS = [
  { id: "PRJ-FLM", name: "Frontier Language Models", lead: "Dr. Maya Chen", costCenter: "CC-410", monthlyBudgetCents: 52_000_000 },
  { id: "PRJ-MMP", name: "Multimodal Perception", lead: "Ravi Shah", costCenter: "CC-420", monthlyBudgetCents: 24_000_000 },
  { id: "PRJ-RLA", name: "RL and Agents", lead: "Elena Petrova", costCenter: "CC-430", monthlyBudgetCents: 15_000_000 },
  { id: "PRJ-INF", name: "Inference Efficiency", lead: "Diego Alvarez", costCenter: "CC-460", monthlyBudgetCents: 4_000_000 },
];

const PROVIDERS = [
  { id: "PRV-HELIOS", name: "Lambda", shortName: "Lambda", billingEmail: "billing@lambda.example" },
  { id: "PRV-STRATUS", name: "CoreWeave", shortName: "CoreWeave", billingEmail: "ar@coreweave.example" },
  { id: "PRV-MERIDIAN", name: "Nebius", shortName: "Nebius", billingEmail: "billing@nebius.example" },
];

const HELIOS_CLAUSES: ContractClause[] = [
  { ref: "3.1", title: "Rates", text: "On-demand 8x H100 instances are billed at $100.00 per instance-hour; 8x A100 at $64.00." },
  { ref: "4.1", title: "Metering increment", text: "Usage is metered per started hour from the PROVISIONED event." },
  { ref: "4.2", title: "Termination ends billing", text: "Billing ends when the instance reaches TERMINATED, as confirmed by the provider API. No charges accrue after termination." },
  { ref: "4.3", title: "Idle running instances", text: "Instances in a running state are billable whether or not a workload is active." },
  { ref: "4.4", title: "Minimum duration", text: "There is no minimum duration beyond the first metered hour." },
  { ref: "7.2", title: "Billing disputes", text: "Disputes must be raised within 60 days of the invoice date. Verified metering errors are credited in full." },
];

const STRATUS_CLAUSES: ContractClause[] = [
  { ref: "2.1", title: "Reserved capacity rates", text: "Reserved H100 capacity is priced per GPU-hour as stated on each reservation order." },
  { ref: "2.4", title: "Reserved capacity billed in full", text: "Reserved capacity is billed in full for the reservation term whether or not it is used." },
  { ref: "2.6", title: "Internal sharing of reservations", text: "The customer may share reserved capacity across internal teams. CoreWeave invoices each reservation as a single line." },
  { ref: "6.1", title: "Billing disputes", text: "Disputes must be raised within 30 days of the invoice date." },
];

const MERIDIAN_CLAUSES: ContractClause[] = [
  { ref: "1.2", title: "Rates", text: "8x H200 instances are billed at $120.00 per instance-hour." },
  { ref: "3.1", title: "Metering increment", text: "Usage is metered per started hour." },
  { ref: "3.4", title: "Minimum duration", text: "Each instance launch is billed for a minimum of 8 hours." },
  { ref: "3.5", title: "Termination ends billing", text: "Billing ends at instance termination." },
  { ref: "3.6", title: "Idle running instances", text: "Running instances are billable whether or not a workload is active." },
];

function seedReferenceData(ctx: AppContext) {
  ctx.db.insert(actors).values(ACTOR_SEED).run();
  ctx.db.insert(projects).values(PROJECTS).run();
  ctx.db.insert(providers).values(PROVIDERS).run();
  ctx.db
    .insert(contracts)
    .values([
      {
        id: "HC-2025-114",
        providerId: "PRV-HELIOS",
        name: "Lambda Master Services Agreement",
        effectiveFrom: "2025-07-01",
        rateCard: { "h100.8x": 10_000, "a100.8x": 6_400 },
        billingIncrementHours: 1,
        minimumHours: 1,
        idleBillable: true,
        reservationsBilledInFull: true,
        clauses: HELIOS_CLAUSES,
      },
      {
        id: "SG-2026-007",
        providerId: "PRV-STRATUS",
        name: "CoreWeave Reserved Capacity Agreement",
        effectiveFrom: "2026-01-01",
        rateCard: { "h100.8x": 8_800 },
        billingIncrementHours: 1,
        minimumHours: 1,
        idleBillable: true,
        reservationsBilledInFull: true,
        clauses: STRATUS_CLAUSES,
      },
      {
        id: "MC-2026-031",
        providerId: "PRV-MERIDIAN",
        name: "Nebius Order Form",
        effectiveFrom: "2026-02-15",
        rateCard: { "h200.8x": 12_000 },
        billingIncrementHours: 1,
        minimumHours: 8,
        idleBillable: true,
        reservationsBilledInFull: true,
        clauses: MERIDIAN_CLAUSES,
      },
    ])
    .run();
  ctx.db
    .insert(ledgerAccounts)
    .values([
      { code: "2000", name: "Accounts Payable - Cloud Providers", type: "liability" },
      { code: "6100", name: "GPU Compute Expense (by project)", type: "expense" },
      { code: "6990", name: "Compute Clearing (unallocated)", type: "expense" },
    ])
    .run();
  ctx.db
    .insert(policies)
    .values([
      {
        id: "POL-AUTO-MATCH-v1",
        policyKey: "AUTO-MATCH",
        version: 1,
        title: "Exact-match auto-allocation",
        status: "APPROVED",
        statement:
          "Invoice lines that equal the contract-supported charge and have a single owning project are allocated to that project without further approval, up to $500,000.",
        rule: {
          method: "single_owner",
          autoPostLimitCents: 50_000_000,
          appliesTo: "Exact-match invoice lines",
          conditions: ["Invoice equals contract-supported charge", "Exactly one owning project", "Amount at or below $500,000"],
        },
        rationale: "Adopted at the Q1 2026 close review to remove manual matching of clean lines.",
        evidenceIds: [],
        precedentIds: [],
        proposedBy: ACTOR.controller,
        approvedBy: ACTOR.controller,
        createdAt: "2026-01-08T17:00:00.000Z",
        approvedAt: "2026-01-08T17:00:00.000Z",
      },
      {
        id: "POL-RECON-EXPLAINED-v1",
        policyKey: "RECON-EXPLAINED",
        version: 1,
        title: "Explained variance auto-allocation",
        status: "APPROVED",
        statement:
          "When an invoice equals the contract-supported charge for the instance lifetime, differences from scheduler runtime are explained because running instances are billable. The full charge may be allocated to the owning project without approval, up to $10,000.",
        rule: {
          method: "single_owner",
          autoPostLimitCents: 1_000_000,
          appliesTo: "Instance charges that differ from scheduler runtime",
          conditions: ["Invoice equals contract-supported charge", "Single owning project", "Amount at or below $10,000"],
        },
        rationale: "Idle time on running instances is a cost-efficiency question, not a billing error.",
        evidenceIds: [],
        precedentIds: [],
        proposedBy: ACTOR.controller,
        approvedBy: ACTOR.controller,
        createdAt: "2026-02-03T17:00:00.000Z",
        approvedAt: "2026-02-03T17:00:00.000Z",
      },
      {
        id: "POL-ALLOC-SHARED-v1",
        policyKey: "ALLOC-SHARED",
        version: 1,
        title: "Shared reservation allocation",
        status: "APPROVED",
        statement: "Shared GPU reservations are allocated to projects in proportion to the scheduler-recorded GPU-hours each project used.",
        rule: {
          method: "usage_proportional",
          autoPostLimitCents: 2_500_000,
          appliesTo: "Shared GPU reservations used by more than one project",
          conditions: ["Weights are scheduler-recorded GPU-hours", "Unused capacity is spread in proportion to usage"],
        },
        rationale: "Simple, auditable chargeback adopted when reservations were first shared across teams.",
        evidenceIds: [],
        precedentIds: [],
        proposedBy: ACTOR.controller,
        approvedBy: ACTOR.controller,
        createdAt: "2025-03-04T18:00:00.000Z",
        approvedAt: "2025-03-04T18:00:00.000Z",
      },
    ])
    .run();
  ctx.db
    .insert(precedents)
    .values([
      {
        id: "PREC-101",
        kind: "allocation",
        decidedAt: "2026-07-31T20:00:00.000Z",
        decidedBy: ACTOR.controller,
        title: "RSV-1874 split by usage between Frontier Language Models and RL and Agents",
        summary: "Applied ALLOC-SHARED v1 to a $9,600 shared reservation (70/30 by scheduler GPU-hours). The reservation terms did not assign unused capacity.",
        tags: ["allocation", "shared_reservation", "usage_proportional"],
        details: { reservationId: "RSV-1874", amountCents: 960_000 },
        source: "seed",
        workItemId: null,
      },
      {
        id: "PREC-102",
        kind: "allocation",
        decidedAt: "2026-08-31T20:00:00.000Z",
        decidedBy: ACTOR.controller,
        title: "RSV-1960 split by usage between Multimodal Perception and Inference Efficiency",
        summary: "Applied ALLOC-SHARED v1 to a $7,200 shared reservation. Both teams had agreed to usage-based chargeback in the reservation request.",
        tags: ["allocation", "shared_reservation", "usage_proportional"],
        details: { reservationId: "RSV-1960", amountCents: 720_000 },
        source: "seed",
        workItemId: null,
      },
      {
        id: "PREC-103",
        kind: "vendor_dispute",
        decidedAt: "2026-09-12T20:00:00.000Z",
        decidedBy: ACTOR.controller,
        title: "Lambda credited 10 h billed after termination on i-hel-3920",
        summary: "Lambda metered an instance 10 hours past its TERMINATED event. The controller approved dispute DSP-0412 and Lambda issued a full $1,000 credit.",
        tags: ["vendor_dispute", "helios", "termination", "billing", "credit"],
        details: { creditCents: 100_000, disputeId: "DSP-0412" },
        source: "seed",
        workItemId: null,
      },
    ])
    .run();
  appendAudit(ctx, {
    actorId: ACTOR.simulator,
    action: "environment.seed",
    category: "system",
    details: { note: "Simulated Atlas Research environment loaded (projects, contracts, policies, precedents)." },
  });
}

export function isSeeded(ctx: AppContext) {
  const row = ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM actors").get() as { n: number };
  return row.n > 0;
}

/** Add actors introduced after a database was seeded. Actors are append-only, so existing rows are left as they are. */
export function ensureActors(ctx: AppContext) {
  ctx.db.insert(actors).values(ACTOR_SEED).onConflictDoNothing().run();
  // The controller's name follows the environment (CONTROLLER_NAME, or "You" on a public demo).
  ctx.db.update(actors).set({ name: controllerName() }).where(eq(actors.id, ACTOR.controller)).run();
}

/**
 * Load the simulated environment through the real ingestion pipeline. "demo"
 * loads only the clean lines, which auto-match and open no tasks, so the app
 * starts quiet and the presenter triggers the one case to watch live. "all"
 * loads every case in cases.ts for the eval and tests.
 */
export function seedEnvironment(ctx: AppContext, cases: "demo" | "all" = "all") {
  tx(ctx, () => {
    seedReferenceData(ctx);
    seedApHistory(ctx);
    seedFeedSchedule(ctx);
  });
  const seeded = cases === "all" ? SEED_CASES : SEED_CASES.filter((c) => c.category === "clean");
  for (const c of seeded) ingestCase(ctx, c.data);
  recordActivity(ctx, {
    actorId: ACTOR.simulator,
    type: "SYSTEM",
    status: "info",
    title: "Atlas Research sandbox loaded for the October 2026 close",
  });
  scheduleOnboarding(ctx);
}

/**
 * Bring a database seeded by an older version up to date without wiping it:
 * new actors, AP history, the feed schedule, and onboarding.
 */
export function upgradeEnvironment(ctx: AppContext) {
  tx(ctx, () => {
    ensureActors(ctx);
    const history = ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM erp_ap_history").get() as { n: number };
    if (history.n === 0) seedApHistory(ctx);
    const feed = ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM feed_events").get() as { n: number };
    if (feed.n === 0) seedFeedSchedule(ctx);
    for (const p of PROVIDERS) {
      // Databases created before the providers were renamed to real GPU clouds pick up the new names.
      ctx.db.update(providers).set({ name: p.name, shortName: p.shortName }).where(eq(providers.id, p.id)).run();
      ctx.db.update(providers).set({ billingEmail: p.billingEmail }).where(and(eq(providers.id, p.id), isNull(providers.billingEmail))).run();
    }
  });
  scheduleOnboarding(ctx);
}
