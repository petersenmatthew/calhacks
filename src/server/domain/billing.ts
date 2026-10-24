import { clean, round2 } from "./money";

export interface ContractTerms {
  billingIncrementHours: number;
  minimumHours: number;
}

export function hoursBetween(start: string, end: string) {
  return clean((Date.parse(end) - Date.parse(start)) / 3_600_000);
}

/** Wall-clock hours covered by a set of intervals, counting overlaps once. */
export function unionHours(intervals: { start: string; end: string }[]) {
  const sorted = intervals
    .map((i) => [Date.parse(i.start), Date.parse(i.end)] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return clean(total / 3_600_000);
}

/**
 * Hours the provider may bill under the contract: the instance lifetime
 * rounded up to the billing increment, never less than the minimum.
 * Billing follows the instance lifecycle, not the training job.
 */
export function contractBillableHours(lifecycleHours: number, terms: ContractTerms) {
  const increments = Math.ceil(clean(lifecycleHours / terms.billingIncrementHours));
  return round2(Math.max(increments * terms.billingIncrementHours, terms.minimumHours));
}

export function expectedChargeCents(billableHours: number, rateCentsPerHour: number) {
  return Math.round(billableHours * rateCentsPerHour);
}
