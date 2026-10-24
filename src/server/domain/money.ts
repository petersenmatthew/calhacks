/** All money is integer cents. Floating point never touches stored amounts. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return sign + "$" + dollars.toLocaleString("en-US") + "." + rest;
}

/** Round a float to 6 decimals to remove binary noise before ceil/floor. */
export function clean(n: number) {
  return Math.round(n * 1e6) / 1e6;
}

export function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export interface WeightedShare {
  key: string;
  weight: number;
}

/**
 * Split totalCents across weights so the parts sum exactly to the total.
 * Uses the largest-remainder method; ties go to the larger weight, then key.
 */
export function splitByWeights(totalCents: number, shares: WeightedShare[]): Map<string, number> {
  if (!Number.isInteger(totalCents)) throw new Error("totalCents must be an integer");
  const positive = shares.filter((s) => s.weight > 0);
  if (positive.length === 0) throw new Error("At least one positive weight is required");
  const totalWeight = positive.reduce((sum, s) => sum + s.weight, 0);
  const raw = positive.map((s) => {
    const exact = (totalCents * s.weight) / totalWeight;
    const floor = Math.floor(clean(exact));
    return { ...s, floor, remainder: clean(exact) - floor };
  });
  let leftover = totalCents - raw.reduce((sum, r) => sum + r.floor, 0);
  const order = [...raw].sort(
    (a, b) => b.remainder - a.remainder || b.weight - a.weight || (a.key < b.key ? -1 : 1),
  );
  const result = new Map(raw.map((r) => [r.key, r.floor]));
  for (const r of order) {
    if (leftover <= 0) break;
    result.set(r.key, (result.get(r.key) ?? 0) + 1);
    leftover -= 1;
  }
  return result;
}
