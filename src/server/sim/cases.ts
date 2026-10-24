import type { ScenarioData } from "./scenarios";
import { buildInstanceCase, buildReservationCase } from "./scenarios";

/*
 * Seeded October cases with answer keys. Every case flows through the normal
 * ingestion pipeline when the environment is seeded; the evaluation harness
 * then plays the controller and scores the agents against each key.
 *
 * Keys are derived from the contracts and source records, not from agent output:
 * - Helios: $100/h H100, $64/h A100, per started hour, no minimum beyond 1 h.
 * - Meridian: $120/h H200, per started hour, 8 h minimum per launch.
 * - Stratus reservations: committed GPU-hours x rate, billed in full.
 */

export type CaseCategory =
  | "clean"
  | "idle_explained"
  | "minimum_duration"
  | "overbilling"
  | "rate_mismatch"
  | "duplicate_line"
  | "missing_owner"
  | "shared_usage"
  | "shared_owner_idle";

export type CaseOutcome =
  | "AUTO_MATCHED"
  | "CHARGE_EXPLAINED"
  | "CHARGE_ALLOCATED"
  | "VENDOR_CREDIT"
  | "CHARGE_UPHELD"
  | "ALLOCATED_UNDER_POLICY"
  | "ALLOCATED_WITH_APPROVAL";

export interface AnswerKey {
  outcome: CaseOutcome;
  /** Amount that should be disputed with the vendor. 0 means the case must not be disputed. */
  disputeCents: number;
  /** Final expense posted to each project for this invoice line. */
  allocation: Record<string, number>;
  /** Standing policy that should authorize the final allocation; null means a controller approval. */
  policyId: string | null;
  /** Allocation method the controller expects for shared reservations. */
  method?: string;
  /** Controller's answer if the agents ask who owns the charge. */
  ownerAnswer?: string;
  /** Simulated vendor reply to an approved dispute. */
  vendorReply?: "accept" | "deny";
  /** Reason the controller gives when rejecting a wrong proposal. */
  correction?: string;
  /**
   * The right answer depends on something only the controller knows, so a first
   * dispute is expected. Excluded from the false-positive rate; tests recovery.
   */
  outOfBand?: boolean;
}

export interface SeedCase {
  id: string;
  category: CaseCategory;
  title: string;
  data: ScenarioData;
  key: AnswerKey;
}

const AUTO = "POL-AUTO-MATCH-v1";
const EXPLAINED = "POL-RECON-EXPLAINED-v1";
const SHARED_V1 = "POL-ALLOC-SHARED-v1";
const SHARED_V2 = "POL-ALLOC-SHARED-v2";
const OWNER_IDLE_CORRECTION =
  "Reserved capacity must be charged to the team that owns the reservation, subject to company policy.";

/** The same usage billed again on a later invoice. No new source records. */
function rebill(original: ScenarioData, invoice: { id: string; number: string; lineId: string }, hours?: number): ScenarioData {
  const line = original.event.line;
  const quantity = hours ?? line.quantity;
  return {
    experiments: [],
    reservations: [],
    instances: [],
    lifecycle: [],
    jobs: [],
    usage: [],
    event: {
      externalEventId: "evt-" + invoice.lineId,
      source: original.event.source,
      invoice: { ...original.event.invoice, id: invoice.id, invoiceNumber: invoice.number, issuedAt: "2026-10-28T12:00:00.000Z" },
      line: {
        ...line,
        id: invoice.lineId,
        externalLineId: invoice.lineId,
        quantity,
        amountCents: Math.round(quantity * line.unitPriceCents),
        description: line.description.replace(/: [\d.]+ h x/, ": " + quantity + " h x"),
      },
    },
  };
}

const D1 = buildInstanceCase({
  key: "d1", providerId: "PRV-HELIOS", instanceId: "i-hel-4608", instanceType: "h100.8x", projectId: "PRJ-INF",
  experimentId: "exp-inf-batching-v3", experimentName: "Continuous batching v3", owner: "Diego Alvarez",
  provisionedAt: "2026-10-12T08:00:00.000Z", lifecycleHours: 24, jobHours: 23.6, billedHours: 24, rateCents: 10_000,
  invoice: { id: "INV-HEL-2026-10-131", number: "HEL-2026-10-131", lineId: "HEL-2026-10-131-L1" }, jobId: "job-88501",
});

const D2 = buildInstanceCase({
  key: "d2", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2306", instanceType: "h200.8x", projectId: "PRJ-FLM",
  experimentId: "exp-flm-long-context", experimentName: "Long-context extension eval", owner: "Jonah Brooks",
  provisionedAt: "2026-10-13T14:00:00.000Z", lifecycleHours: 12, jobHours: 11.5, billedHours: 12, rateCents: 12_000,
  invoice: { id: "INV-MER-2026-10-024", number: "MER-2026-10-024", lineId: "MER-2026-10-024-L1" }, jobId: "job-88502",
});

export const SEED_CASES: SeedCase[] = [
  /* ---------- Background lines: clean and auto-matched ---------- */
  {
    id: "C-01", category: "clean", title: "Dedicated FLM pretraining reservation",
    data: buildReservationCase({
      reservationId: "RSV-2100", ownerProjectId: "PRJ-FLM", requestedBy: "Dr. Maya Chen", gpuCount: 192, hours: 744, rateCents: 250,
      startAt: "2026-10-01T00:00:00.000Z", period: "2026-10", ownerAccountableForIdle: true,
      internalTerms: "Dedicated pretraining cluster for Frontier Language Models. Not shared.",
      invoice: { id: "INV-STR-2026-10-031", number: "STR-2026-10-031", lineId: "STR-2026-10-031-L1" },
      jobs: [{ jobId: "job-87001", experimentId: "exp-flm-pretrain-34b", experimentName: "34B pretraining run 4", projectId: "PRJ-FLM", owner: "Dr. Maya Chen", gpus: 192, startOffsetH: 2, hours: 700 }],
    }),
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-FLM": 35_712_000 }, policyId: AUTO },
  },
  {
    id: "C-02", category: "clean", title: "Dedicated MMP reservation",
    data: buildReservationCase({
      reservationId: "RSV-2120", ownerProjectId: "PRJ-MMP", requestedBy: "Ravi Shah", gpuCount: 96, hours: 744, rateCents: 250,
      startAt: "2026-10-01T00:00:00.000Z", period: "2026-10", ownerAccountableForIdle: true,
      internalTerms: "Dedicated capacity for Multimodal Perception. Not shared.",
      invoice: { id: "INV-STR-2026-10-032", number: "STR-2026-10-032", lineId: "STR-2026-10-032-L1" },
      jobs: [{ jobId: "job-87011", experimentId: "exp-mmp-video-encoder", experimentName: "Video encoder scaling sweep", projectId: "PRJ-MMP", owner: "Ravi Shah", gpus: 96, startOffsetH: 4, hours: 690 }],
    }),
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-MMP": 17_856_000 }, policyId: AUTO },
  },
  {
    id: "C-03", category: "clean", title: "Dedicated RLA reservation",
    data: buildReservationCase({
      reservationId: "RSV-2150", ownerProjectId: "PRJ-RLA", requestedBy: "Elena Petrova", gpuCount: 64, hours: 600, rateCents: 275,
      startAt: "2026-10-03T00:00:00.000Z", period: "2026-10", ownerAccountableForIdle: true,
      internalTerms: "Dedicated capacity for RL and Agents. Not shared.",
      invoice: { id: "INV-STR-2026-10-033", number: "STR-2026-10-033", lineId: "STR-2026-10-033-L1" },
      jobs: [{ jobId: "job-87021", experimentId: "exp-rla-env-suite", experimentName: "Agent environment suite v6", projectId: "PRJ-RLA", owner: "Elena Petrova", gpus: 64, startOffsetH: 1, hours: 560 }],
    }),
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-RLA": 10_560_000 }, policyId: AUTO },
  },
  {
    id: "C-04", category: "clean", title: "Helios A100, 72 h, billed exactly",
    data: buildInstanceCase({
      key: "bg-1", providerId: "PRV-HELIOS", instanceId: "i-hel-4402", instanceType: "a100.8x", projectId: "PRJ-MMP",
      experimentId: "exp-mmp-clip-distill", experimentName: "CLIP distillation ablation", owner: "Ravi Shah",
      provisionedAt: "2026-10-02T09:00:00.000Z", lifecycleHours: 72, jobHours: 71.6, billedHours: 72, rateCents: 6_400,
      invoice: { id: "INV-HEL-2026-10-104", number: "HEL-2026-10-104", lineId: "HEL-2026-10-104-L1" }, jobId: "job-86410",
    }),
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-MMP": 460_800 }, policyId: AUTO },
  },
  {
    id: "C-05", category: "clean", title: "Helios H100, 48 h, billed exactly",
    data: buildInstanceCase({
      key: "bg-2", providerId: "PRV-HELIOS", instanceId: "i-hel-4410", instanceType: "h100.8x", projectId: "PRJ-FLM",
      experimentId: "exp-flm-tokenizer-v9", experimentName: "Tokenizer v9 evaluation", owner: "Jonah Brooks",
      provisionedAt: "2026-10-05T13:00:00.000Z", lifecycleHours: 48, jobHours: 47.5, billedHours: 48, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-104", number: "HEL-2026-10-104", lineId: "HEL-2026-10-104-L2" }, jobId: "job-86455",
    }),
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-FLM": 480_000 }, policyId: AUTO },
  },
  {
    id: "C-06", category: "clean", title: "Meridian H200, 40 h, billed exactly",
    data: buildInstanceCase({
      key: "bg-3", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2207", instanceType: "h200.8x", projectId: "PRJ-RLA",
      experimentId: "exp-rla-reward-model", experimentName: "Reward model refresh", owner: "Elena Petrova",
      provisionedAt: "2026-10-07T06:00:00.000Z", lifecycleHours: 40, jobHours: 39.4, billedHours: 40, rateCents: 12_000,
      invoice: { id: "INV-MER-2026-10-019", number: "MER-2026-10-019", lineId: "MER-2026-10-019-L1" }, jobId: "job-86502",
    }),
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-RLA": 480_000 }, policyId: AUTO },
  },
  {
    id: "C-07", category: "clean", title: "Helios H100, 96 h, billed exactly",
    data: buildInstanceCase({
      key: "bg-4", providerId: "PRV-HELIOS", instanceId: "i-hel-4433", instanceType: "h100.8x", projectId: "PRJ-INF",
      experimentId: "exp-inf-spec-decoding", experimentName: "Speculative decoding benchmark", owner: "Diego Alvarez",
      provisionedAt: "2026-10-09T00:00:00.000Z", lifecycleHours: 96, jobHours: 95.2, billedHours: 96, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-104", number: "HEL-2026-10-104", lineId: "HEL-2026-10-104-L4" }, jobId: "job-86577",
    }),
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-INF": 960_000 }, policyId: AUTO },
  },
  {
    id: "C-08", category: "clean", title: "Meridian H200, 20 h, billed exactly",
    data: buildInstanceCase({
      key: "bg-5", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2215", instanceType: "h200.8x", projectId: "PRJ-MMP",
      experimentId: "exp-mmp-ocr-finetune", experimentName: "Document OCR finetune", owner: "Lena Ortiz",
      provisionedAt: "2026-10-11T15:00:00.000Z", lifecycleHours: 20, jobHours: 19.7, billedHours: 20, rateCents: 12_000,
      invoice: { id: "INV-MER-2026-10-019", number: "MER-2026-10-019", lineId: "MER-2026-10-019-L2" }, jobId: "job-86611",
    }),
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-MMP": 240_000 }, policyId: AUTO },
  },

  /* ---------- The opening work item (WI-1001): job ended early, charge is correct ---------- */
  {
    id: "E-01", category: "idle_explained", title: "Helios H100 up 24 h, job ran 18 h",
    data: buildInstanceCase({
      key: "live-1", providerId: "PRV-HELIOS", instanceId: "i-hel-4519", instanceType: "h100.8x", projectId: "PRJ-RLA",
      experimentId: "exp-rla-planner-rl", experimentName: "Planner RL fine-tune", owner: "Elena Petrova",
      provisionedAt: "2026-10-16T10:00:00.000Z", lifecycleHours: 24, jobHours: 18, billedHours: 24, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-121", number: "HEL-2026-10-121", lineId: "HEL-2026-10-121-L1" }, jobId: "job-88340",
    }),
    key: { outcome: "CHARGE_EXPLAINED", disputeCents: 0, allocation: { "PRJ-RLA": 240_000 }, policyId: EXPLAINED },
  },

  /* ---------- More clean lines ---------- */
  {
    id: "C-09", category: "clean", title: "Helios H100, 30 h, billed exactly",
    data: buildInstanceCase({
      key: "c9", providerId: "PRV-HELIOS", instanceId: "i-hel-4601", instanceType: "h100.8x", projectId: "PRJ-INF",
      experimentId: "exp-inf-distill-7b", experimentName: "7B distillation for serving", owner: "Diego Alvarez",
      provisionedAt: "2026-10-04T10:00:00.000Z", lifecycleHours: 30, jobHours: 29.6, billedHours: 30, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-104", number: "HEL-2026-10-104", lineId: "HEL-2026-10-104-L5" }, jobId: "job-86620",
    }),
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-INF": 300_000 }, policyId: AUTO },
  },
  {
    id: "C-10", category: "clean", title: "Meridian H200, 16 h, billed exactly",
    data: buildInstanceCase({
      key: "c10", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2301", instanceType: "h200.8x", projectId: "PRJ-FLM",
      experimentId: "exp-flm-data-mix", experimentName: "Data mixture ablation", owner: "Jonah Brooks",
      provisionedAt: "2026-10-08T03:00:00.000Z", lifecycleHours: 16, jobHours: 15.5, billedHours: 16, rateCents: 12_000,
      invoice: { id: "INV-MER-2026-10-019", number: "MER-2026-10-019", lineId: "MER-2026-10-019-L3" }, jobId: "job-86630",
    }),
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-FLM": 192_000 }, policyId: AUTO },
  },
  {
    id: "C-11", category: "clean", title: "Helios A100, 12 h, billed exactly",
    data: buildInstanceCase({
      key: "c11", providerId: "PRV-HELIOS", instanceId: "i-hel-4602", instanceType: "a100.8x", projectId: "PRJ-RLA",
      experimentId: "exp-rla-sim-rollouts", experimentName: "Simulator rollout collection", owner: "Elena Petrova",
      provisionedAt: "2026-10-10T18:00:00.000Z", lifecycleHours: 12, jobHours: 11.8, billedHours: 12, rateCents: 6_400,
      invoice: { id: "INV-HEL-2026-10-104", number: "HEL-2026-10-104", lineId: "HEL-2026-10-104-L6" }, jobId: "job-86640",
    }),
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-RLA": 76_800 }, policyId: AUTO },
  },

  /* ---------- Idle time on a running instance: billable, not a billing error ---------- */
  {
    id: "E-02", category: "idle_explained", title: "Helios H100 up 40 h, job ran 30 h",
    data: buildInstanceCase({
      key: "e2", providerId: "PRV-HELIOS", instanceId: "i-hel-4603", instanceType: "h100.8x", projectId: "PRJ-MMP",
      experimentId: "exp-mmp-audio-tokens", experimentName: "Audio tokenizer pretraining", owner: "Lena Ortiz",
      provisionedAt: "2026-10-15T06:00:00.000Z", lifecycleHours: 40, jobHours: 30, billedHours: 40, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-121", number: "HEL-2026-10-121", lineId: "HEL-2026-10-121-L2" }, jobId: "job-88350",
    }),
    key: { outcome: "CHARGE_EXPLAINED", disputeCents: 0, allocation: { "PRJ-MMP": 400_000 }, policyId: EXPLAINED },
  },
  {
    id: "E-03", category: "idle_explained", title: "Helios H100 up 120 h, job ran 90 h; above the $10,000 policy limit",
    data: buildInstanceCase({
      key: "e3", providerId: "PRV-HELIOS", instanceId: "i-hel-4604", instanceType: "h100.8x", projectId: "PRJ-FLM",
      experimentId: "exp-flm-rlhf-sweep", experimentName: "RLHF reward sweep", owner: "Dr. Maya Chen",
      provisionedAt: "2026-10-17T00:00:00.000Z", lifecycleHours: 120, jobHours: 90, billedHours: 120, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-121", number: "HEL-2026-10-121", lineId: "HEL-2026-10-121-L3" }, jobId: "job-88360",
    }),
    key: { outcome: "CHARGE_ALLOCATED", disputeCents: 0, allocation: { "PRJ-FLM": 1_200_000 }, policyId: null },
  },

  /* ---------- Minimum-duration charges ---------- */
  {
    id: "M-01", category: "minimum_duration", title: "Meridian H200 up 3 h, billed the 8 h minimum",
    data: buildInstanceCase({
      key: "m1", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2302", instanceType: "h200.8x", projectId: "PRJ-INF",
      experimentId: "exp-inf-fp8-smoke", experimentName: "FP8 kernel smoke test", owner: "Diego Alvarez",
      provisionedAt: "2026-10-14T12:00:00.000Z", lifecycleHours: 3, jobHours: 2.5, billedHours: 8, rateCents: 12_000,
      invoice: { id: "INV-MER-2026-10-024", number: "MER-2026-10-024", lineId: "MER-2026-10-024-L2" }, jobId: "job-88410",
    }),
    key: { outcome: "CHARGE_EXPLAINED", disputeCents: 0, allocation: { "PRJ-INF": 96_000 }, policyId: EXPLAINED },
  },
  {
    id: "M-02", category: "minimum_duration", title: "Meridian H200 up 5.5 h, billed the 8 h minimum",
    data: buildInstanceCase({
      key: "m2", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2303", instanceType: "h200.8x", projectId: "PRJ-MMP",
      experimentId: "exp-mmp-grounding-eval", experimentName: "Visual grounding eval", owner: "Ravi Shah",
      provisionedAt: "2026-10-15T09:00:00.000Z", lifecycleHours: 5.5, jobHours: 5, billedHours: 8, rateCents: 12_000,
      invoice: { id: "INV-MER-2026-10-024", number: "MER-2026-10-024", lineId: "MER-2026-10-024-L3" }, jobId: "job-88411",
    }),
    key: { outcome: "CHARGE_EXPLAINED", disputeCents: 0, allocation: { "PRJ-MMP": 96_000 }, policyId: EXPLAINED },
  },
  {
    id: "M-03", category: "minimum_duration", title: "Meridian H200 up 3 h, billed 10 h (2 h past the minimum)",
    data: buildInstanceCase({
      key: "m3", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2304", instanceType: "h200.8x", projectId: "PRJ-RLA",
      experimentId: "exp-rla-critic-probe", experimentName: "Critic probe", owner: "Elena Petrova",
      provisionedAt: "2026-10-16T20:00:00.000Z", lifecycleHours: 3, jobHours: 2.6, billedHours: 10, meterHours: 10, rateCents: 12_000,
      invoice: { id: "INV-MER-2026-10-024", number: "MER-2026-10-024", lineId: "MER-2026-10-024-L4" }, jobId: "job-88412",
    }),
    key: { outcome: "VENDOR_CREDIT", disputeCents: 24_000, allocation: { "PRJ-RLA": 96_000 }, policyId: null, vendorReply: "accept" },
  },
  {
    id: "M-04", category: "minimum_duration", title: "Helios H100 up 2 h, billed an 8 h minimum the contract does not have",
    data: buildInstanceCase({
      key: "m4", providerId: "PRV-HELIOS", instanceId: "i-hel-4611", instanceType: "h100.8x", projectId: "PRJ-INF",
      experimentId: "exp-inf-profiler", experimentName: "Serving profiler run", owner: "Diego Alvarez",
      provisionedAt: "2026-10-18T15:00:00.000Z", lifecycleHours: 2, jobHours: 1.5, billedHours: 8, meterHours: 8, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-133", number: "HEL-2026-10-133", lineId: "HEL-2026-10-133-L1" }, jobId: "job-88413",
    }),
    key: {
      outcome: "CHARGE_UPHELD", disputeCents: 60_000, allocation: { "PRJ-INF": 80_000 }, policyId: null, vendorReply: "deny",
    },
  },

  /* ---------- Billed past termination ---------- */
  {
    id: "O-01", category: "overbilling", title: "Helios H100 terminated at 30 h, billed 38 h",
    data: buildInstanceCase({
      key: "o1", providerId: "PRV-HELIOS", instanceId: "i-hel-4612", instanceType: "h100.8x", projectId: "PRJ-MMP",
      experimentId: "exp-mmp-diffusion-ft", experimentName: "Diffusion decoder finetune", owner: "Lena Ortiz",
      provisionedAt: "2026-10-19T04:00:00.000Z", lifecycleHours: 30, jobHours: 29, billedHours: 38, meterHours: 38, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-133", number: "HEL-2026-10-133", lineId: "HEL-2026-10-133-L2" }, jobId: "job-88414",
    }),
    key: { outcome: "VENDOR_CREDIT", disputeCents: 80_000, allocation: { "PRJ-MMP": 300_000 }, policyId: null, vendorReply: "accept" },
  },

  {
    id: "O-02", category: "overbilling", title: "Helios billed 6 h past termination that the team asked Helios to keep",
    data: buildInstanceCase({
      key: "o2", providerId: "PRV-HELIOS", instanceId: "i-hel-4613", instanceType: "h100.8x", projectId: "PRJ-RLA",
      experimentId: "exp-rla-debug-hold", experimentName: "Planner crash investigation", owner: "Elena Petrova",
      provisionedAt: "2026-10-19T12:00:00.000Z", lifecycleHours: 12, jobHours: 11.5, billedHours: 18, meterHours: 18, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-133", number: "HEL-2026-10-133", lineId: "HEL-2026-10-133-L6" }, jobId: "job-88415",
    }),
    key: {
      outcome: "CHARGE_ALLOCATED", disputeCents: 0, allocation: { "PRJ-RLA": 180_000 }, policyId: null, outOfBand: true,
      correction: "We asked Helios to hold the disk image for 6 h after termination for the crash investigation. The charge is ours; do not dispute it.",
    },
  },

  /* ---------- Rate mismatches ---------- */
  {
    id: "R-01", category: "rate_mismatch", title: "Helios H100 billed at $110/h vs $100 contract",
    data: buildInstanceCase({
      key: "r1", providerId: "PRV-HELIOS", instanceId: "i-hel-4605", instanceType: "h100.8x", projectId: "PRJ-FLM",
      experimentId: "exp-flm-code-sft", experimentName: "Code SFT mixture", owner: "Jonah Brooks",
      provisionedAt: "2026-10-20T01:00:00.000Z", lifecycleHours: 24, jobHours: 23.5, billedHours: 24, rateCents: 11_000,
      invoice: { id: "INV-HEL-2026-10-133", number: "HEL-2026-10-133", lineId: "HEL-2026-10-133-L3" }, jobId: "job-88420",
    }),
    key: { outcome: "VENDOR_CREDIT", disputeCents: 24_000, allocation: { "PRJ-FLM": 240_000 }, policyId: null, vendorReply: "accept" },
  },
  {
    id: "R-02", category: "rate_mismatch", title: "Meridian H200 billed at $135/h vs $120 contract",
    data: buildInstanceCase({
      key: "r2", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2305", instanceType: "h200.8x", projectId: "PRJ-INF",
      experimentId: "exp-inf-moe-serving", experimentName: "MoE serving load test", owner: "Diego Alvarez",
      provisionedAt: "2026-10-20T10:00:00.000Z", lifecycleHours: 10, jobHours: 9.5, billedHours: 10, rateCents: 13_500,
      invoice: { id: "INV-MER-2026-10-027", number: "MER-2026-10-027", lineId: "MER-2026-10-027-L1" }, jobId: "job-88421",
    }),
    key: { outcome: "VENDOR_CREDIT", disputeCents: 15_000, allocation: { "PRJ-INF": 120_000 }, policyId: null, vendorReply: "accept" },
  },
  {
    id: "R-03", category: "rate_mismatch", title: "Helios A100 billed at the H100 rate",
    data: buildInstanceCase({
      key: "r3", providerId: "PRV-HELIOS", instanceId: "i-hel-4606", instanceType: "a100.8x", projectId: "PRJ-MMP",
      experimentId: "exp-mmp-caption-filter", experimentName: "Caption quality filter", owner: "Ravi Shah",
      provisionedAt: "2026-10-21T07:00:00.000Z", lifecycleHours: 20, jobHours: 19.5, billedHours: 20, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-133", number: "HEL-2026-10-133", lineId: "HEL-2026-10-133-L4" }, jobId: "job-88422",
    }),
    key: { outcome: "VENDOR_CREDIT", disputeCents: 72_000, allocation: { "PRJ-MMP": 128_000 }, policyId: null, vendorReply: "accept" },
  },
  {
    id: "R-04", category: "rate_mismatch", title: "Helios H100 billed at $90/h, below contract",
    data: buildInstanceCase({
      key: "r4", providerId: "PRV-HELIOS", instanceId: "i-hel-4607", instanceType: "h100.8x", projectId: "PRJ-RLA",
      experimentId: "exp-rla-self-play", experimentName: "Self-play league", owner: "Elena Petrova",
      provisionedAt: "2026-10-21T16:00:00.000Z", lifecycleHours: 10, jobHours: 9.5, billedHours: 10, rateCents: 9_000,
      invoice: { id: "INV-HEL-2026-10-133", number: "HEL-2026-10-133", lineId: "HEL-2026-10-133-L5" }, jobId: "job-88423",
    }),
    key: { outcome: "CHARGE_ALLOCATED", disputeCents: 0, allocation: { "PRJ-RLA": 90_000 }, policyId: null },
  },

  /* ---------- Duplicate invoice lines ---------- */
  {
    id: "D-01a", category: "clean", title: "Helios H100, 24 h, first billing",
    data: D1,
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-INF": 240_000 }, policyId: AUTO },
  },
  {
    id: "D-01b", category: "duplicate_line", title: "Same Helios instance billed again on a later invoice",
    data: rebill(D1, { id: "INV-HEL-2026-10-140", number: "HEL-2026-10-140", lineId: "HEL-2026-10-140-L1" }),
    key: { outcome: "VENDOR_CREDIT", disputeCents: 240_000, allocation: {}, policyId: null, vendorReply: "accept" },
  },
  {
    id: "D-02a", category: "clean", title: "Meridian H200, 12 h, first billing",
    data: D2,
    key: { outcome: "AUTO_MATCHED", disputeCents: 0, allocation: { "PRJ-FLM": 144_000 }, policyId: AUTO },
  },
  {
    id: "D-02b", category: "duplicate_line", title: "Same Meridian instance billed again for 6 h",
    data: rebill(D2, { id: "INV-MER-2026-10-031", number: "MER-2026-10-031", lineId: "MER-2026-10-031-L1" }, 6),
    key: { outcome: "VENDOR_CREDIT", disputeCents: 72_000, allocation: {}, policyId: null, vendorReply: "accept" },
  },

  /* ---------- Missing experiment owners ---------- */
  {
    id: "N-01", category: "missing_owner", title: "Helios H100 charge with no owning project",
    data: buildInstanceCase({
      key: "n1", providerId: "PRV-HELIOS", instanceId: "i-hel-4609", instanceType: "h100.8x", projectId: null,
      experimentId: "exp-scratch-0412", experimentName: "Untagged scratch run", owner: "unknown",
      provisionedAt: "2026-10-22T02:00:00.000Z", lifecycleHours: 16, jobHours: 15.6, billedHours: 16, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-140", number: "HEL-2026-10-140", lineId: "HEL-2026-10-140-L2" }, jobId: "job-88430",
    }),
    key: {
      outcome: "CHARGE_EXPLAINED", disputeCents: 0, allocation: { "PRJ-RLA": 160_000 }, policyId: EXPLAINED,
      ownerAnswer: "That scratch run was RL and Agents. Charge it to PRJ-RLA.",
    },
  },
  {
    id: "N-02", category: "missing_owner", title: "Meridian minimum charge with no owning project",
    data: buildInstanceCase({
      key: "n2", providerId: "PRV-MERIDIAN", instanceId: "i-mer-2307", instanceType: "h200.8x", projectId: null,
      experimentId: "exp-scratch-0415", experimentName: "Untagged notebook session", owner: "unknown",
      provisionedAt: "2026-10-22T11:00:00.000Z", lifecycleHours: 4, jobHours: 3.5, billedHours: 8, rateCents: 12_000,
      invoice: { id: "INV-MER-2026-10-031", number: "MER-2026-10-031", lineId: "MER-2026-10-031-L2" }, jobId: "job-88431",
    }),
    key: {
      outcome: "CHARGE_EXPLAINED", disputeCents: 0, allocation: { "PRJ-MMP": 96_000 }, policyId: EXPLAINED,
      ownerAnswer: "Lena's notebook for Multimodal Perception. Use PRJ-MMP.",
    },
  },
  {
    id: "N-03", category: "missing_owner", title: "Unowned Helios instance also billed past termination",
    data: buildInstanceCase({
      key: "n3", providerId: "PRV-HELIOS", instanceId: "i-hel-4610", instanceType: "h100.8x", projectId: null,
      experimentId: "exp-scratch-0419", experimentName: "Untagged eval job", owner: "unknown",
      provisionedAt: "2026-10-23T05:00:00.000Z", lifecycleHours: 10, jobHours: 9.6, billedHours: 14, meterHours: 14, rateCents: 10_000,
      invoice: { id: "INV-HEL-2026-10-140", number: "HEL-2026-10-140", lineId: "HEL-2026-10-140-L3" }, jobId: "job-88432",
    }),
    key: {
      outcome: "VENDOR_CREDIT", disputeCents: 40_000, allocation: { "PRJ-FLM": 100_000 }, policyId: null, vendorReply: "accept",
      ownerAnswer: "That eval belongs to Frontier Language Models, PRJ-FLM.",
    },
  },

  /* ---------- Shared reservations: usage-based chargeback agreed, so policy v1 fits ---------- */
  {
    id: "S-01", category: "shared_usage", title: "RLA reservation shared with INF, usage chargeback agreed",
    data: buildReservationCase({
      reservationId: "RSV-2310", ownerProjectId: "PRJ-RLA", requestedBy: "Elena Petrova", gpuCount: 16, hours: 100, rateCents: 500,
      startAt: "2026-10-08T00:00:00.000Z", period: "2026-10", ownerAccountableForIdle: false,
      internalTerms: "Booked jointly by RL and Agents and Inference Efficiency. Both teams agreed to usage-based chargeback.",
      invoice: { id: "INV-STR-2026-10-046", number: "STR-2026-10-046", lineId: "STR-2026-10-046-L1" },
      jobs: [
        { jobId: "job-88601", experimentId: "exp-rla-web-agent", experimentName: "Web agent RL", projectId: "PRJ-RLA", owner: "Elena Petrova", gpus: 8, startOffsetH: 0, hours: 60 },
        { jobId: "job-88602", experimentId: "exp-inf-quant-sweep", experimentName: "Quantization sweep", projectId: "PRJ-INF", owner: "Diego Alvarez", gpus: 8, startOffsetH: 10, hours: 40 },
      ],
    }),
    key: { outcome: "ALLOCATED_UNDER_POLICY", disputeCents: 0, allocation: { "PRJ-RLA": 480_000, "PRJ-INF": 320_000 }, policyId: SHARED_V1, method: "usage_proportional" },
  },
  {
    id: "S-02", category: "shared_usage", title: "MMP reservation shared with FLM, usage chargeback agreed",
    data: buildReservationCase({
      reservationId: "RSV-2311", ownerProjectId: "PRJ-MMP", requestedBy: "Ravi Shah", gpuCount: 8, hours: 150, rateCents: 525,
      startAt: "2026-10-09T00:00:00.000Z", period: "2026-10", ownerAccountableForIdle: false,
      internalTerms: "Multimodal Perception and Frontier Language Models split this reservation by usage, as agreed in the request.",
      invoice: { id: "INV-STR-2026-10-046", number: "STR-2026-10-046", lineId: "STR-2026-10-046-L2" },
      jobs: [
        { jobId: "job-88611", experimentId: "exp-mmp-vqa-ft", experimentName: "VQA finetune", projectId: "PRJ-MMP", owner: "Ravi Shah", gpus: 4, startOffsetH: 0, hours: 150 },
        { jobId: "job-88612", experimentId: "exp-flm-vision-adapter", experimentName: "Vision adapter probe", projectId: "PRJ-FLM", owner: "Jonah Brooks", gpus: 4, startOffsetH: 20, hours: 75 },
      ],
    }),
    key: { outcome: "ALLOCATED_UNDER_POLICY", disputeCents: 0, allocation: { "PRJ-MMP": 420_000, "PRJ-FLM": 210_000 }, policyId: SHARED_V1, method: "usage_proportional" },
  },

  /* ---------- Shared reservations where the reserving team owns idle capacity ---------- */
  {
    id: "S-03", category: "shared_owner_idle", title: "FLM reservation borrowed by RLA; FLM accountable for idle hours",
    data: buildReservationCase({
      reservationId: "RSV-2320", ownerProjectId: "PRJ-FLM", requestedBy: "Dr. Maya Chen", gpuCount: 16, hours: 100, rateCents: 500,
      startAt: "2026-10-12T00:00:00.000Z", period: "2026-10", ownerAccountableForIdle: true,
      internalTerms:
        "Reserved by Frontier Language Models. The reserving team accepts financial responsibility for reserved capacity, including unused hours. Other teams may borrow idle capacity.",
      invoice: { id: "INV-STR-2026-10-047", number: "STR-2026-10-047", lineId: "STR-2026-10-047-L1" },
      jobs: [
        { jobId: "job-88621", experimentId: "exp-flm-rope-scaling", experimentName: "RoPE scaling study", projectId: "PRJ-FLM", owner: "Dr. Maya Chen", gpus: 8, startOffsetH: 0, hours: 50 },
        { jobId: "job-88622", experimentId: "exp-rla-negotiation", experimentName: "Negotiation agent training", projectId: "PRJ-RLA", owner: "Elena Petrova", gpus: 8, startOffsetH: 10, hours: 50 },
      ],
    }),
    key: {
      outcome: "ALLOCATED_WITH_APPROVAL", disputeCents: 0, allocation: { "PRJ-FLM": 600_000, "PRJ-RLA": 200_000 }, policyId: null,
      method: "owner_pays_idle", correction: OWNER_IDLE_CORRECTION,
    },
  },
  {
    id: "S-04", category: "shared_owner_idle", title: "INF reservation borrowed by MMP; applies the learned policy",
    data: buildReservationCase({
      reservationId: "RSV-2321", ownerProjectId: "PRJ-INF", requestedBy: "Diego Alvarez", gpuCount: 8, hours: 120, rateCents: 500,
      startAt: "2026-10-14T00:00:00.000Z", period: "2026-10", ownerAccountableForIdle: true,
      internalTerms:
        "Reserved by Inference Efficiency. The reserving team accepts financial responsibility for reserved capacity, including unused hours. Multimodal Perception may borrow idle capacity.",
      invoice: { id: "INV-STR-2026-10-047", number: "STR-2026-10-047", lineId: "STR-2026-10-047-L2" },
      jobs: [
        { jobId: "job-88631", experimentId: "exp-inf-paged-attn", experimentName: "Paged attention benchmark", projectId: "PRJ-INF", owner: "Diego Alvarez", gpus: 8, startOffsetH: 0, hours: 60 },
        { jobId: "job-88632", experimentId: "exp-mmp-ocr-distill", experimentName: "OCR distillation", projectId: "PRJ-MMP", owner: "Lena Ortiz", gpus: 4, startOffsetH: 60, hours: 60 },
      ],
    }),
    // Seeded before the correction, so its first proposal follows v1. After S-03 teaches v2, the rework posts under v2.
    key: {
      outcome: "ALLOCATED_UNDER_POLICY", disputeCents: 0, allocation: { "PRJ-INF": 360_000, "PRJ-MMP": 120_000 }, policyId: SHARED_V2,
      method: "owner_pays_idle", correction: OWNER_IDLE_CORRECTION,
    },
  },
];
