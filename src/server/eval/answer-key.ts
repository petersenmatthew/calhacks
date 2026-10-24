import type { AppContext } from "../context";
import { buildInstanceCase, buildReservationCase, ingestCase, type InstanceCaseInput } from "../sim/scenarios";
import { ingestBillingEvent, type IngestionResult } from "../workflow/ingestion";

/*
 * Answer key. Each case plants one situation in an invoice line and states,
 * in hand-computed numbers, what a competent AP accountant would do with it.
 * The expected amounts are written out here, not computed by the app, so the
 * evaluation checks the system against the key rather than against itself.
 *
 * Contract facts the key relies on (see sim/seed.ts):
 * - Helios: H100 $100.00/h, A100 $64.00/h, per started hour, billing ends at TERMINATED.
 * - Meridian: H200 $120.00/h, per started hour, 8-hour minimum per launch.
 * - Learned materiality policy: variances up to $50 per line are accepted (approved before the run).
 */

export type Expected =
  | { outcome: "auto_match" }
  | { outcome: "duplicate" }
  | { outcome: "dispute"; disputedCents: number }
  | { outcome: "allocate_full"; totalCents: number; posted: boolean | "either" }
  | { outcome: "accept_below_materiality"; totalCents: number }
  | { outcome: "allocation"; lines: Record<string, number>; posted: boolean }
  | { outcome: "escalate_conflict" }
  | { outcome: "ask_human" };

export type Category = "overcharge" | "correct_invoice" | "judgment";

export interface EvalCase {
  id: string;
  title: string;
  planted: string;
  category: Category;
  expected: Expected;
  run: (ctx: AppContext) => IngestionResult;
}

let n = 0;
function instance(input: Omit<InstanceCaseInput, "key" | "invoice" | "jobId" | "experimentId" | "experimentName" | "owner"> & { owner?: string }) {
  n += 1;
  const id = "EVAL-" + String(n).padStart(2, "0");
  return buildInstanceCase({
    key: id,
    experimentId: "exp-eval-" + n,
    experimentName: "Eval experiment " + n,
    owner: input.owner ?? "Eval owner",
    invoice: { id: "INV-" + id, number: id, lineId: id + "-L1" },
    jobId: "job-eval-" + n,
    ...input,
  });
}

const H100 = { providerId: "PRV-HELIOS", instanceType: "h100.8x" } as const;
const A100 = { providerId: "PRV-HELIOS", instanceType: "a100.8x" } as const;
const H200 = { providerId: "PRV-MERIDIAN", instanceType: "h200.8x" } as const;
const T0 = "2026-10-12T00:00:00.000Z";

export function answerKey(): EvalCase[] {
  n = 0;
  return [
    {
      id: "exact-match",
      title: "Helios H100, 48 h run, billed 48 h at contract rate",
      planted: "Nothing. Control case.",
      category: "correct_invoice",
      expected: { outcome: "auto_match" },
      run: (ctx) => ingestCase(ctx, instance({ ...H100, instanceId: "i-eval-01", projectId: "PRJ-FLM", provisionedAt: T0, lifecycleHours: 48, jobHours: 47.5, billedHours: 48, rateCents: 10_000 })),
    },
    {
      id: "billed-after-termination",
      title: "Helios billed 36 h for an instance terminated after 24 h",
      planted: "12 h billed after the TERMINATED event ($1,200).",
      category: "overcharge",
      expected: { outcome: "dispute", disputedCents: 120_000 },
      run: (ctx) => ingestCase(ctx, instance({ ...H100, instanceId: "i-eval-02", projectId: "PRJ-FLM", provisionedAt: T0, lifecycleHours: 24, jobHours: 22, billedHours: 36, meterHours: 36, rateCents: 10_000 })),
    },
    {
      id: "rate-above-contract",
      title: "Helios H100 billed at $110/h for 20 h",
      planted: "$10/h above the $100 contract rate ($200).",
      category: "overcharge",
      expected: { outcome: "dispute", disputedCents: 20_000 },
      run: (ctx) => ingestCase(ctx, instance({ ...H100, instanceId: "i-eval-03", projectId: "PRJ-RLA", provisionedAt: T0, lifecycleHours: 20, jobHours: 19.6, billedHours: 20, rateCents: 11_000 })),
    },
    {
      id: "wrong-rate-card",
      title: "Helios A100 hours billed at the H100 rate",
      planted: "10 A100 hours at $100 instead of $64 ($360).",
      category: "overcharge",
      expected: { outcome: "dispute", disputedCents: 36_000 },
      run: (ctx) => ingestCase(ctx, instance({ ...A100, instanceId: "i-eval-04", projectId: "PRJ-MMP", provisionedAt: T0, lifecycleHours: 10, jobHours: 9.6, billedHours: 10, rateCents: 10_000 })),
    },
    {
      id: "one-extra-hour",
      title: "Helios billed 11 h for a 10 h instance",
      planted: "One hour after termination ($100), above the $50 materiality threshold.",
      category: "overcharge",
      expected: { outcome: "dispute", disputedCents: 10_000 },
      run: (ctx) => ingestCase(ctx, instance({ ...H100, instanceId: "i-eval-05", projectId: "PRJ-INF", provisionedAt: T0, lifecycleHours: 10, jobHours: 9.6, billedHours: 11, meterHours: 11, rateCents: 10_000 })),
    },
    {
      id: "small-rate-drift",
      title: "Meridian H200 billed at $120.50/h for 20 h",
      planted: "$10 variance, below the $50 materiality threshold: accept, do not dispute.",
      category: "judgment",
      expected: { outcome: "accept_below_materiality", totalCents: 241_000 },
      run: (ctx) => ingestCase(ctx, instance({ ...H200, instanceId: "i-eval-06", projectId: "PRJ-INF", provisionedAt: T0, lifecycleHours: 20, jobHours: 19.6, billedHours: 20, rateCents: 12_050 })),
    },
    {
      id: "idle-after-job",
      title: "Helios 24 h instance whose training job ended after 12 h",
      planted: "Nothing wrong: the instance was up, so all 24 h are billable ($2,400).",
      category: "correct_invoice",
      expected: { outcome: "allocate_full", totalCents: 240_000, posted: true },
      run: (ctx) => ingestCase(ctx, instance({ ...H100, instanceId: "i-eval-07", projectId: "PRJ-RLA", provisionedAt: T0, lifecycleHours: 24, jobHours: 12, billedHours: 24, rateCents: 10_000 })),
    },
    {
      id: "contract-minimum",
      title: "Meridian 2 h launch billed 8 h",
      planted: "Nothing wrong: Meridian bills an 8-hour minimum per launch ($960).",
      category: "correct_invoice",
      expected: { outcome: "allocate_full", totalCents: 96_000, posted: true },
      run: (ctx) => ingestCase(ctx, instance({ ...H200, instanceId: "i-eval-08", projectId: "PRJ-MMP", provisionedAt: T0, lifecycleHours: 2, jobHours: 1.5, billedHours: 8, meterHours: 2, rateCents: 12_000 })),
    },
    {
      id: "per-started-hour",
      title: "Helios 30.4 h instance billed 31 h",
      planted: "Nothing wrong: Helios meters per started hour ($3,100).",
      category: "correct_invoice",
      expected: { outcome: "allocate_full", totalCents: 310_000, posted: true },
      run: (ctx) => ingestCase(ctx, instance({ ...H100, instanceId: "i-eval-09", projectId: "PRJ-FLM", provisionedAt: T0, lifecycleHours: 30.4, jobHours: 30, billedHours: 31, meterHours: 30.4, rateCents: 10_000 })),
    },
    {
      id: "underbilled",
      title: "Helios billed 20 h for a 24 h instance",
      planted: "Vendor under-billed by $400. Pay what was billed; never dispute in your own favour.",
      category: "judgment",
      expected: { outcome: "allocate_full", totalCents: 200_000, posted: "either" },
      run: (ctx) => ingestCase(ctx, instance({ ...H100, instanceId: "i-eval-10", projectId: "PRJ-INF", provisionedAt: T0, lifecycleHours: 24, jobHours: 23.5, billedHours: 20, meterHours: 24, rateCents: 10_000 })),
    },
    {
      id: "no-owner",
      title: "Helios charge for an instance whose experiment has no project",
      planted: "Owner unknown. Ask a person instead of guessing whose budget to charge.",
      category: "judgment",
      expected: { outcome: "ask_human" },
      run: (ctx) => ingestCase(ctx, instance({ ...H100, instanceId: "i-eval-11", projectId: null, provisionedAt: T0, lifecycleHours: 16, jobHours: 15.5, billedHours: 16, rateCents: 10_000 })),
    },
    {
      id: "duplicate-event",
      title: "The same Helios billing event delivered twice",
      planted: "Webhook retry. Must not create a second work item or posting.",
      category: "judgment",
      expected: { outcome: "duplicate" },
      run: (ctx) => {
        const data = instance({ ...H100, instanceId: "i-eval-12", projectId: "PRJ-FLM", provisionedAt: T0, lifecycleHours: 12, jobHours: 11.6, billedHours: 12, rateCents: 10_000 });
        ingestCase(ctx, data);
        return ingestBillingEvent(ctx, data.event);
      },
    },
    {
      id: "shared-usage-agreed",
      title: "Stratus reservation shared by two teams that agreed usage-based chargeback",
      planted: "8 GPUs x 100 h at $5 = $4,000. FLM used 480 GPU-h, RLA 240, 80 idle. Written policy fits: split by usage.",
      category: "correct_invoice",
      expected: { outcome: "allocation", lines: { "PRJ-FLM": 266_667, "PRJ-RLA": 133_333 }, posted: true },
      run: (ctx) =>
        ingestCase(
          ctx,
          buildReservationCase({
            reservationId: "RSV-EVAL-1", ownerProjectId: "PRJ-FLM", requestedBy: "Eval owner", gpuCount: 8, hours: 100, rateCents: 500,
            startAt: "2026-10-05T00:00:00.000Z", period: "2026-10", ownerAccountableForIdle: false,
            internalTerms: "Shared between FLM and RLA. Both teams agreed to usage-based chargeback.",
            invoice: { id: "INV-EVAL-R1", number: "EVAL-R1", lineId: "EVAL-R1-L1" },
            jobs: [
              { jobId: "job-eval-r1a", experimentId: "exp-eval-r1a", experimentName: "Eval FLM", projectId: "PRJ-FLM", owner: "Eval", gpus: 8, startOffsetH: 0, hours: 60 },
              { jobId: "job-eval-r1b", experimentId: "exp-eval-r1b", experimentName: "Eval RLA", projectId: "PRJ-RLA", owner: "Eval", gpus: 8, startOffsetH: 60, hours: 30 },
            ],
          }),
        ),
    },
    {
      id: "shared-policy-conflict",
      title: "Stratus reservation whose terms contradict the written allocation policy",
      planted: "Terms make the owner pay for idle capacity; policy v1 spreads it. Do not auto-post; ask the controller.",
      category: "judgment",
      expected: { outcome: "escalate_conflict" },
      run: (ctx) =>
        ingestCase(
          ctx,
          buildReservationCase({
            reservationId: "RSV-EVAL-2", ownerProjectId: "PRJ-MMP", requestedBy: "Eval owner", gpuCount: 8, hours: 100, rateCents: 500,
            startAt: "2026-10-05T00:00:00.000Z", period: "2026-10", ownerAccountableForIdle: true,
            internalTerms: "Reserved by MMP. The reserving team accepts financial responsibility for unused hours. RLA may borrow idle capacity.",
            invoice: { id: "INV-EVAL-R2", number: "EVAL-R2", lineId: "EVAL-R2-L1" },
            jobs: [
              { jobId: "job-eval-r2a", experimentId: "exp-eval-r2a", experimentName: "Eval MMP", projectId: "PRJ-MMP", owner: "Eval", gpus: 8, startOffsetH: 0, hours: 50 },
              { jobId: "job-eval-r2b", experimentId: "exp-eval-r2b", experimentName: "Eval RLA 2", projectId: "PRJ-RLA", owner: "Eval", gpus: 8, startOffsetH: 50, hours: 30 },
            ],
          }),
        ),
    },
  ];
}
