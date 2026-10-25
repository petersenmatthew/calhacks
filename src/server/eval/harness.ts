import { eq } from "drizzle-orm";
import type { AppContext } from "../context";
import { approvalRequests, policies, proposals, vendorDisputes, workItems, workItemTransitions } from "../db/schema";
import type { Orchestrator } from "../orchestrator";
import { ACTOR } from "../security/actors";
import { SEED_CASES, type SeedCase } from "../sim/cases";
import { decideApproval } from "../workflow/approvals";
import { recordVendorResponse } from "../workflow/decisions";
import { provideInformation } from "../workflow/info";

/*
 * Evaluation harness. Runs on a freshly seeded environment: the agents work
 * every seeded case, and the harness plays the controller using each case's
 * answer key (approve what matches, reject with the key's correction otherwise,
 * answer ownership questions, and send the vendor reply). Cases are driven one
 * at a time in catalog order, so a policy learned on one case can apply to the
 * cases after it.
 */

export interface CaseResult {
  id: string;
  category: string;
  title: string;
  correct: boolean;
  problems: string[];
  outcome: string | null;
  state: string | null;
  disputed: boolean;
  disputedCents: number | null;
  allocation: Record<string, number>;
  policyIds: (string | null)[];
  rejections: number;
  askedForInfo: boolean;
}

export interface EvalReport {
  cases: CaseResult[];
  metrics: {
    total: number;
    correct: number;
    accuracy: number;
    /** Cases the records show should not be disputed, where the agents proposed a dispute anyway. */
    falsePositiveDisputes: number;
    noDisputeCases: number;
    falsePositiveDisputeRate: number;
    /** Posted cases whose final allocation was authorized by the policy the key expects. */
    correctPolicy: number;
    policyCases: number;
    policyAccuracy: number;
    /** Cases where the controller rejected work at least once and the case still ended correct. */
    recovered: number;
    rejectedCases: number;
    recoveryRate: number;
  };
}

const MAX_ROUNDS = 8;

function lineAllocation(ctx: AppContext, lineId: string) {
  const rows = ctx.sqlite
    .prepare(
      "SELECT jl.project_id AS p, SUM(jl.debit_cents - jl.credit_cents) AS amt FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id " +
        "WHERE je.invoice_line_id = ? AND jl.account_code = '6100' GROUP BY jl.project_id",
    )
    .all(lineId) as { p: string; amt: number }[];
  return Object.fromEntries(rows.filter((r) => r.amt !== 0).map((r) => [r.p, r.amt]));
}

/** Policies on the allocation entries for a line; null where a controller approval authorized it. */
function linePolicies(ctx: AppContext, lineId: string) {
  const rows = ctx.sqlite
    .prepare(
      "SELECT DISTINCT je.policy_id AS policy FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id " +
        "WHERE je.invoice_line_id = ? AND je.source = 'experiment_ledger' AND jl.account_code = '6100' AND jl.debit_cents > 0",
    )
    .all(lineId) as { policy: string | null }[];
  return rows.map((r) => r.policy);
}

function sameAllocation(a: Record<string, number>, b: Record<string, number>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => (a[k] ?? 0) === (b[k] ?? 0));
}

function itemForLine(ctx: AppContext, lineId: string) {
  return ctx.db.select().from(workItems).where(eq(workItems.invoiceLineId, lineId)).get() ?? null;
}

/** Act once as the controller or vendor on a case. Returns false when there is nothing to do. */
function controllerStep(ctx: AppContext, c: SeedCase, workItemId: string): boolean {
  const item = ctx.db.select().from(workItems).where(eq(workItems.id, workItemId)).get();
  if (!item || item.state === "RESOLVED") return false;
  const key = c.key;

  if (item.state === "NEEDS_INFO") {
    if (!key.ownerAnswer) return false;
    provideInformation(ctx, { workItemId, actorId: ACTOR.controller, answer: key.ownerAnswer });
    return true;
  }

  if (item.state === "DISPUTED") {
    const dispute = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, workItemId)).get();
    if (!dispute || dispute.status !== "SUBMITTED") return false;
    recordVendorResponse(ctx, { workItemId, outcome: key.vendorReply ?? "accept" });
    return true;
  }

  const pending = ctx.db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.workItemId, workItemId))
    .all()
    .filter((a) => a.status === "PENDING");
  if (!pending.length) return false;
  for (const approval of pending) {
    // Approving a rule can settle a proposal it covers, so skip anything already decided.
    const fresh = ctx.db.select().from(approvalRequests).where(eq(approvalRequests.id, approval.id)).get();
    if (fresh?.status !== "PENDING") continue;
    if (approval.subjectType === "POLICY") {
      const policy = ctx.db.select().from(policies).where(eq(policies.id, approval.subjectId)).get();
      const ok = Boolean(key.method) && policy?.rule.method === key.method;
      decideApproval(ctx, {
        approvalId: approval.id,
        actorId: ACTOR.controller,
        decision: ok ? "APPROVED" : "REJECTED",
        reason: ok ? null : "This policy does not match how we charge these cases.",
      });
      continue;
    }
    const proposal = ctx.db.select().from(proposals).where(eq(proposals.id, approval.subjectId)).get();
    if (!proposal) continue;
    let ok: boolean;
    let reason: string;
    if (proposal.kind === "VENDOR_DISPUTE") {
      ok = key.disputeCents > 0 && proposal.payload.dispute?.disputedCents === key.disputeCents;
      reason =
        key.disputeCents === 0
          ? "This charge is supported by the contract. Do not dispute it; allocate it to the owning project."
          : "The disputed amount does not match the contract-supported charge.";
    } else {
      const alloc = Object.fromEntries(proposal.payload.allocation.map((l) => [l.projectId, l.amountCents]));
      ok = key.disputeCents === 0 && sameAllocation(alloc, key.allocation);
      reason = key.correction ?? (key.disputeCents > 0 ? "Part of this charge is not supported by the contract." : "The allocation does not match the evidence.");
    }
    decideApproval(ctx, {
      approvalId: approval.id,
      actorId: ACTOR.controller,
      decision: ok ? "APPROVED" : "REJECTED",
      reason: ok ? null : reason,
    });
  }
  return true;
}

function scoreCase(ctx: AppContext, c: SeedCase): CaseResult {
  const lineId = c.data.event.line.id;
  const item = itemForLine(ctx, lineId);
  const key = c.key;
  const problems: string[] = [];
  const outcome = item ? item.outcome : (ctx.sqlite.prepare("SELECT outcome FROM reconciliations WHERE invoice_line_id = ?").get(lineId) as { outcome: string } | undefined)?.outcome ?? null;
  const props = item ? ctx.db.select().from(proposals).where(eq(proposals.workItemId, item.id)).all() : [];
  const disputes = props.filter((p) => p.kind === "VENDOR_DISPUTE");
  const finalDispute = disputes.sort((a, b) => b.version - a.version)[0];
  const approvals = item ? ctx.db.select().from(approvalRequests).where(eq(approvalRequests.workItemId, item.id)).all() : [];
  const rejections = approvals.filter((a) => a.subjectType === "PROPOSAL" && (a.status === "REJECTED" || a.status === "CHANGES_REQUESTED")).length;
  const askedForInfo = item
    ? ctx.db.select().from(workItemTransitions).where(eq(workItemTransitions.workItemId, item.id)).all().some((t) => t.toState === "NEEDS_INFO")
    : false;
  const allocation = lineAllocation(ctx, lineId);
  const policyIds = linePolicies(ctx, lineId);
  const executedDispute = disputes.find((p) => p.status === "EXECUTED");

  if (outcome !== key.outcome) problems.push("outcome " + outcome + ", expected " + key.outcome);
  if (key.disputeCents === 0 && executedDispute) problems.push("disputed a supported charge");
  if (key.disputeCents > 0 && executedDispute?.payload.dispute?.disputedCents !== key.disputeCents) {
    problems.push("disputed " + (executedDispute?.payload.dispute?.disputedCents ?? 0) + ", expected " + key.disputeCents);
  }
  if (!sameAllocation(allocation, key.allocation)) problems.push("allocation " + JSON.stringify(allocation) + ", expected " + JSON.stringify(key.allocation));
  const expectedPolicies = Object.keys(key.allocation).length ? [key.policyId] : [];
  if (JSON.stringify(policyIds) !== JSON.stringify(expectedPolicies)) {
    problems.push("authorized by " + JSON.stringify(policyIds) + ", expected " + JSON.stringify(expectedPolicies));
  }
  if (key.ownerAnswer && !askedForInfo) problems.push("did not ask who owns the charge");

  return {
    id: c.id,
    category: c.category,
    title: c.title,
    correct: problems.length === 0,
    problems,
    outcome,
    state: item?.state ?? null,
    disputed: disputes.length > 0,
    disputedCents: finalDispute?.payload.dispute?.disputedCents ?? null,
    allocation,
    policyIds,
    rejections,
    askedForInfo,
  };
}

const pct = (n: number, d: number) => (d === 0 ? 1 : n / d);

/** Drive every seeded case to completion as the controller, then score against the answer keys. */
export async function runEvaluation(ctx: AppContext, orchestrator: Orchestrator, cases: SeedCase[] = SEED_CASES): Promise<EvalReport> {
  await orchestrator.drain();
  for (const c of cases) {
    const item = itemForLine(ctx, c.data.event.line.id);
    if (!item) continue;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      if (!controllerStep(ctx, c, item.id)) break;
      await orchestrator.drain();
    }
  }
  const results = cases.map((c) => scoreCase(ctx, c));
  const noDispute = cases.filter((c) => c.key.disputeCents === 0 && !c.key.outOfBand);
  const falsePositives = results.filter((r, i) => cases[i].key.disputeCents === 0 && !cases[i].key.outOfBand && r.disputed).length;
  const policyCases = results.filter((r, i) => Object.keys(cases[i].key.allocation).length > 0);
  const correctPolicy = policyCases.filter((r) => {
    const c = cases.find((x) => x.id === r.id)!;
    return JSON.stringify(r.policyIds) === JSON.stringify([c.key.policyId]);
  }).length;
  const rejected = results.filter((r) => r.rejections > 0);
  const correct = results.filter((r) => r.correct).length;
  return {
    cases: results,
    metrics: {
      total: results.length,
      correct,
      accuracy: pct(correct, results.length),
      falsePositiveDisputes: falsePositives,
      noDisputeCases: noDispute.length,
      falsePositiveDisputeRate: noDispute.length ? falsePositives / noDispute.length : 0,
      correctPolicy,
      policyCases: policyCases.length,
      policyAccuracy: pct(correctPolicy, policyCases.length),
      recovered: rejected.filter((r) => r.correct).length,
      rejectedCases: rejected.length,
      recoveryRate: pct(rejected.filter((r) => r.correct).length, rejected.length),
    },
  };
}

export function formatReport(report: EvalReport) {
  const m = report.metrics;
  const p = (x: number) => (x * 100).toFixed(1) + "%";
  const lines = [
    "Case   Result  Outcome                  Category",
    ...report.cases.map(
      (r) =>
        r.id.padEnd(7) + (r.correct ? "pass" : "FAIL").padEnd(8) + String(r.outcome ?? r.state ?? "-").padEnd(25) + r.category +
        (r.problems.length ? "\n         " + r.problems.join("; ") : ""),
    ),
    "",
    "Accuracy                  " + m.correct + "/" + m.total + "  " + p(m.accuracy),
    "False-positive disputes   " + m.falsePositiveDisputes + "/" + m.noDisputeCases + "  " + p(m.falsePositiveDisputeRate),
    "Correct policy use        " + m.correctPolicy + "/" + m.policyCases + "  " + p(m.policyAccuracy),
    "Recovered after rejection " + m.recovered + "/" + m.rejectedCases + "  " + p(m.recoveryRate),
  ];
  return lines.join("\n");
}
