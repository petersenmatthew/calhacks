import { and, desc, eq } from "drizzle-orm";
import type { AppContext } from "../context";
import { policies, reservations } from "../db/schema";
import { assessPolicyFit } from "../domain/allocation";
import type { WorkItemRow } from "./work-items";

export type PolicyRow = typeof policies.$inferSelect;
export type ProposalLike = { kind: string; method: string; payload: { totalCents: number; allocation: { projectId: string }[] } };

export const POLICY_KEYS = {
  autoMatch: "AUTO-MATCH",
  explainedVariance: "RECON-EXPLAINED",
  sharedReservation: "ALLOC-SHARED",
} as const;

export function getApprovedPolicy(ctx: AppContext, key: string): PolicyRow | null {
  return (
    ctx.db
      .select()
      .from(policies)
      .where(and(eq(policies.policyKey, key), eq(policies.status, "APPROVED")))
      .orderBy(desc(policies.version))
      .get() ?? null
  );
}

export function policyFitForWorkItem(ctx: AppContext, item: WorkItemRow) {
  const policy = getApprovedPolicy(ctx, POLICY_KEYS.sharedReservation);
  const reservation = item.reservationId
    ? ctx.db.select().from(reservations).where(eq(reservations.id, item.reservationId)).get()
    : undefined;
  if (!reservation) return { policy, fit: { policyId: policy?.id ?? null, consistent: false, conflicts: ["No reservation"] } };
  return { policy, fit: assessPolicyFit(policy, reservation) };
}

/**
 * Deterministic check: does an approved standing policy authorize posting
 * this proposal without a new controller approval?
 */
export function evaluateStandingAuthorization(
  ctx: AppContext,
  item: WorkItemRow,
  proposal: ProposalLike,
): { authorized: boolean; policyId: string | null; reason: string } {
  if (proposal.kind !== "ALLOCATION") {
    return { authorized: false, policyId: null, reason: "Vendor disputes always require controller approval." };
  }
  if (item.type === "BILLING_VARIANCE") {
    const policy = getApprovedPolicy(ctx, POLICY_KEYS.explainedVariance);
    if (!policy) return { authorized: false, policyId: null, reason: "No approved policy for explained variances." };
    if (proposal.method !== "single_owner") {
      return { authorized: false, policyId: policy.id, reason: "Only full single-owner allocations qualify." };
    }
    if (Math.abs(item.invoicedCents - item.expectedCents) >= 100) {
      return { authorized: false, policyId: policy.id, reason: "The invoice differs from the contract-supported charge." };
    }
    if (proposal.payload.totalCents > policy.rule.autoPostLimitCents) {
      return { authorized: false, policyId: policy.id, reason: "Amount exceeds the policy auto-post limit." };
    }
    return { authorized: true, policyId: policy.id, reason: policy.title + " v" + policy.version };
  }
  const { policy, fit } = policyFitForWorkItem(ctx, item);
  if (!policy) return { authorized: false, policyId: null, reason: "No approved shared-reservation policy." };
  if (proposal.method !== policy.rule.method) {
    return {
      authorized: false,
      policyId: policy.id,
      reason: "Proposal method " + proposal.method + " differs from approved policy method " + policy.rule.method + ".",
    };
  }
  if (!fit.consistent) return { authorized: false, policyId: policy.id, reason: fit.conflicts.join(" ") };
  if (proposal.payload.totalCents > policy.rule.autoPostLimitCents) {
    return { authorized: false, policyId: policy.id, reason: "Amount exceeds the policy auto-post limit." };
  }
  return { authorized: true, policyId: policy.id, reason: policy.title + " v" + policy.version };
}
