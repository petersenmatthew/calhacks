import type { AllocationLine } from "../db/schema";
import { splitByWeights } from "./money";

export const ALLOCATION_METHODS = [
  "single_owner",
  "undisputed_to_owner",
  "usage_proportional",
  "owner_pays_idle",
  "owner_pays_all",
] as const;

export type AllocationMethod = (typeof ALLOCATION_METHODS)[number];

export const RESERVATION_METHODS: AllocationMethod[] = ["usage_proportional", "owner_pays_idle", "owner_pays_all"];

export const METHOD_LABELS: Record<AllocationMethod, string> = {
  single_owner: "Full charge to owning project",
  undisputed_to_owner: "Contract-supported amount to owning project",
  usage_proportional: "Proportional to GPU-hours used",
  owner_pays_idle: "Usage to each team; idle reserved capacity to reservation owner",
  owner_pays_all: "Entire reservation to reservation owner",
};

export interface ReservationUsage {
  totalCents: number;
  ownerProjectId: string;
  usageByProject: { projectId: string; gpuHours: number }[];
  idleGpuHours: number;
}

/** Allocate a shared reservation charge. Lines always sum exactly to the total. */
export function allocateReservation(method: AllocationMethod, usage: ReservationUsage): AllocationLine[] {
  const weights = new Map<string, number>();
  const basis = new Map<string, string>();
  const used = usage.usageByProject.filter((u) => u.gpuHours > 0);
  if (method === "owner_pays_all" || used.length === 0) {
    weights.set(usage.ownerProjectId, 1);
    basis.set(usage.ownerProjectId, "Reservation owner (entire charge)");
  } else if (method === "usage_proportional") {
    for (const u of used) {
      weights.set(u.projectId, u.gpuHours);
      basis.set(u.projectId, u.gpuHours + " GPU-h used");
    }
  } else if (method === "owner_pays_idle") {
    for (const u of used) {
      weights.set(u.projectId, u.gpuHours);
      basis.set(u.projectId, u.gpuHours + " GPU-h used");
    }
    const ownerUsed = weights.get(usage.ownerProjectId) ?? 0;
    weights.set(usage.ownerProjectId, ownerUsed + usage.idleGpuHours);
    basis.set(
      usage.ownerProjectId,
      ownerUsed + " GPU-h used + " + usage.idleGpuHours + " GPU-h idle reserved capacity",
    );
  } else {
    throw new Error("Method " + method + " does not apply to reservations");
  }
  const split = splitByWeights(
    usage.totalCents,
    [...weights.entries()].map(([key, weight]) => ({ key, weight })),
  );
  return [...split.entries()]
    .map(([projectId, amountCents]) => ({
      projectId,
      amountCents,
      weight: weights.get(projectId) ?? 0,
      basis: basis.get(projectId) ?? "",
    }))
    .sort((a, b) => b.amountCents - a.amountCents);
}

export interface PolicyFit {
  policyId: string | null;
  consistent: boolean;
  conflicts: string[];
}

/**
 * Deterministic check of whether the approved allocation policy fits the
 * reservation's internal terms. A conflict means a human must decide.
 */
export function assessPolicyFit(
  policy: { id: string; version: number; rule: { method: string } } | null,
  reservation: { id: string; ownerAccountableForIdle: boolean },
): PolicyFit {
  if (!policy) {
    return { policyId: null, consistent: false, conflicts: ["No approved allocation policy covers shared reservations."] };
  }
  const conflicts: string[] = [];
  if (reservation.ownerAccountableForIdle && policy.rule.method === "usage_proportional") {
    conflicts.push(
      "Policy v" + policy.version + " spreads unused reserved capacity across borrowing teams, but the " +
        reservation.id + " reservation terms make the reserving team accountable for unused capacity.",
    );
  }
  if (!reservation.ownerAccountableForIdle && policy.rule.method === "owner_pays_idle") {
    conflicts.push(
      "Policy v" + policy.version + " charges idle capacity to the owner, but the " + reservation.id +
        " reservation terms agree usage-based chargeback.",
    );
  }
  return { policyId: policy.id, consistent: conflicts.length === 0, conflicts };
}
