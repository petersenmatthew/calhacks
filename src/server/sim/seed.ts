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
import { ACTOR, ACTOR_SEED } from "../security/actors";
import { buildInstanceCase, buildReservationCase, ingestCase } from "./scenarios";

export const PROJECTS = [
  { id: "PRJ-FLM", name: "Frontier Language Models", lead: "Dr. Maya Chen", costCenter: "CC-410", monthlyBudgetCents: 52_000_000 },
  { id: "PRJ-MMP", name: "Multimodal Perception", lead: "Ravi Shah", costCenter: "CC-420", monthlyBudgetCents: 24_000_000 },
  { id: "PRJ-RLA", name: "RL and Agents", lead: "Elena Petrova", costCenter: "CC-430", monthlyBudgetCents: 15_000_000 },
  { id: "PRJ-INF", name: "Inference Efficiency", lead: "Diego Alvarez", costCenter: "CC-460", monthlyBudgetCents: 4_000_000 },
];

const PROVIDERS = [
  { id: "PRV-HELIOS", name: "Helios Cloud", shortName: "Helios" },
  { id: "PRV-STRATUS", name: "Stratus GPU", shortName: "Stratus" },
  { id: "PRV-MERIDIAN", name: "Meridian Compute", shortName: "Meridian" },
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
  { ref: "2.6", title: "Internal sharing of reservations", text: "The customer may share reserved capacity across internal teams. Stratus invoices each reservation as a single line." },
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
        name: "Helios Cloud Master Services Agreement",
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
        name: "Stratus GPU Reserved Capacity Agreement",
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
        name: "Meridian Compute Order Form",
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
        title: "Helios credited 10 h billed after termination on i-hel-3920",
        summary: "Helios metered an instance 10 hours past its TERMINATED event. The controller approved dispute DSP-0412 and Helios issued a full $1,000 credit.",
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

/** Background October invoices. They flow through the normal ingestion pipeline. */
function backgroundCases() {
  return [
    buildReservationCase({
      reservationId: "RSV-2100",
      ownerProjectId: "PRJ-FLM",
      requestedBy: "Dr. Maya Chen",
      gpuCount: 192,
      hours: 744,
      rateCents: 250,
      startAt: "2026-10-01T00:00:00.000Z",
      period: "2026-10",
      ownerAccountableForIdle: true,
      internalTerms: "Dedicated pretraining cluster for Frontier Language Models. Not shared.",
      invoice: { id: "INV-STR-2026-10-031", number: "STR-2026-10-031", lineId: "STR-2026-10-031-L1" },
      jobs: [
        { jobId: "job-87001", experimentId: "exp-flm-pretrain-34b", experimentName: "34B pretraining run 4", projectId: "PRJ-FLM", owner: "Dr. Maya Chen", gpus: 192, startOffsetH: 2, hours: 700 },
      ],
    }),
    buildReservationCase({
      reservationId: "RSV-2120",
      ownerProjectId: "PRJ-MMP",
      requestedBy: "Ravi Shah",
      gpuCount: 96,
      hours: 744,
      rateCents: 250,
      startAt: "2026-10-01T00:00:00.000Z",
      period: "2026-10",
      ownerAccountableForIdle: true,
      internalTerms: "Dedicated capacity for Multimodal Perception. Not shared.",
      invoice: { id: "INV-STR-2026-10-032", number: "STR-2026-10-032", lineId: "STR-2026-10-032-L1" },
      jobs: [
        { jobId: "job-87011", experimentId: "exp-mmp-video-encoder", experimentName: "Video encoder scaling sweep", projectId: "PRJ-MMP", owner: "Ravi Shah", gpus: 96, startOffsetH: 4, hours: 690 },
      ],
    }),
    buildReservationCase({
      reservationId: "RSV-2150",
      ownerProjectId: "PRJ-RLA",
      requestedBy: "Elena Petrova",
      gpuCount: 64,
      hours: 600,
      rateCents: 275,
      startAt: "2026-10-03T00:00:00.000Z",
      period: "2026-10",
      ownerAccountableForIdle: true,
      internalTerms: "Dedicated capacity for RL and Agents. Not shared.",
      invoice: { id: "INV-STR-2026-10-033", number: "STR-2026-10-033", lineId: "STR-2026-10-033-L1" },
      jobs: [
        { jobId: "job-87021", experimentId: "exp-rla-env-suite", experimentName: "Agent environment suite v6", projectId: "PRJ-RLA", owner: "Elena Petrova", gpus: 64, startOffsetH: 1, hours: 560 },
      ],
    }),
    buildInstanceCase({
      key: "bg-1", providerId: "PRV-HELIOS", instanceId: "i-hel-4402", instanceType: "a100.8x", projectId: "PRJ-MMP",
      experimentId: "exp-mmp-clip-distill", experimentName: "CLIP distillation ablation", owner: "Ravi Shah",
      provisionedAt: "2026-10-02T09:00:00.000Z", lifecycleHours: 72, jobHours: 71.6, billedHours: 72, rateCents: 6_400,
      invoice: { id: "INV-HEL-2026-10-104", number: "HEL-2026-10-104", lineId: "HEL-2026-10-104-L1" }, jobId: "job-86410",
    }),
    buildInstanceCase({
      key: "bg-2", providerId: "PRV-HELIOS", instanceId: "i-hel-4410", instanceType: "h100.8x", projectId: "PRJ-FLM",
      experimentId: "exp-flm-tokenizer-v9", experimentName: "Tokenizer v9 evaluation", owner: "Jonah Brooks",
      provisionedAt: "2026-10-05T13:00:00.000Z", lifecycleHours: 48, jobHours: 47.5, billedHours: 48, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-104", number: "HEL-2026-10-104", lineId: "HEL-2026-10-104-L2" }, jobId: "job-86455",
    }),
    buildInstanceCase({
      key: "bg-3", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2207", instanceType: "h200.8x", projectId: "PRJ-RLA",
      experimentId: "exp-rla-reward-model", experimentName: "Reward model refresh", owner: "Elena Petrova",
      provisionedAt: "2026-10-07T06:00:00.000Z", lifecycleHours: 40, jobHours: 39.4, billedHours: 40, rateCents: 12_000,
      invoice: { id: "INV-MER-2026-10-019", number: "MER-2026-10-019", lineId: "MER-2026-10-019-L1" }, jobId: "job-86502",
    }),
    buildInstanceCase({
      key: "bg-4", providerId: "PRV-HELIOS", instanceId: "i-hel-4433", instanceType: "h100.8x", projectId: "PRJ-INF",
      experimentId: "exp-inf-spec-decoding", experimentName: "Speculative decoding benchmark", owner: "Diego Alvarez",
      provisionedAt: "2026-10-09T00:00:00.000Z", lifecycleHours: 96, jobHours: 95.2, billedHours: 96, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-104", number: "HEL-2026-10-104", lineId: "HEL-2026-10-104-L4" }, jobId: "job-86577",
    }),
    buildInstanceCase({
      key: "bg-5", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2215", instanceType: "h200.8x", projectId: "PRJ-MMP",
      experimentId: "exp-mmp-ocr-finetune", experimentName: "Document OCR finetune", owner: "Lena Ortiz",
      provisionedAt: "2026-10-11T15:00:00.000Z", lifecycleHours: 20, jobHours: 19.7, billedHours: 20, rateCents: 12_000,
      invoice: { id: "INV-MER-2026-10-019", number: "MER-2026-10-019", lineId: "MER-2026-10-019-L2" }, jobId: "job-86611",
    }),
  ];
}

export function isSeeded(ctx: AppContext) {
  const row = ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM actors").get() as { n: number };
  return row.n > 0;
}

/**
 * Load the simulated environment. Background invoices are auto-matched by the
 * real pipeline; one early-job-end invoice is left for the agents so the team
 * is visibly working when the app first opens.
 */
export function seedEnvironment(ctx: AppContext) {
  tx(ctx, () => seedReferenceData(ctx));
  for (const data of backgroundCases()) ingestCase(ctx, data);
  ingestCase(
    ctx,
    buildInstanceCase({
      key: "live-1", providerId: "PRV-HELIOS", instanceId: "i-hel-4519", instanceType: "h100.8x", projectId: "PRJ-RLA",
      experimentId: "exp-rla-planner-rl", experimentName: "Planner RL fine-tune", owner: "Elena Petrova",
      provisionedAt: "2026-10-16T10:00:00.000Z", lifecycleHours: 24, jobHours: 18, billedHours: 24, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-121", number: "HEL-2026-10-121", lineId: "HEL-2026-10-121-L1" }, jobId: "job-88340",
    }),
  );
  recordActivity(ctx, {
    actorId: ACTOR.simulator,
    type: "SYSTEM",
    status: "info",
    title: "Atlas Research sandbox loaded for the October 2026 close",
  });
}
