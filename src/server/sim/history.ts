import type { AppContext } from "../context";
import { erpApHistory } from "../db/schema";
import { ACTOR } from "../security/actors";

/*
 * Six months of simulated AP history exported from the ERP: every GPU invoice
 * line xAnthropenAI paid between April and September 2026, with what the contract
 * supported and how each variance was resolved. Nobody wrote the team's
 * materiality rule down; it only shows up in how the lines were handled.
 * The Controls Lead mines this at onboarding.
 */

type Row = typeof erpApHistory.$inferInsert;

const PERIODS = ["2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];

// Variances (cents) the controller paid as billed: rounding, per-started-hour and small rate drift.
const SMALL_PAID = [420, 960, 1_280, 1_600, 2_150, 2_400, 3_100, 3_600, 4_000, 4_480, 4_800];
// Variances the controller disputed: billing after termination, wrong rate card, duplicated lines.
const DISPUTED = [
  { cents: 64_000, credited: true, note: "Billed 10 h after termination; Lambda credited in full." },
  { cents: 120_000, credited: true, note: "Duplicated line on consolidated invoice; credited." },
  { cents: 19_200, credited: true, note: "A100 hours billed at H100 rate; credited." },
  { cents: 240_000, credited: true, note: "Reservation billed twice for overlapping term; credited." },
  { cents: 9_600, credited: false, note: "Disputed extra metered hour; vendor showed instance was still running. Paid." },
  { cents: 48_000, credited: true, note: "Billed past TERMINATED event; credited after second follow-up." },
];

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildApHistory(): Row[] {
  const rand = mulberry(20261024);
  const rows: Row[] = [];
  const providers = [
    { id: "PRV-HELIOS", code: "HEL", rate: 10_000, type: "h100.8x" },
    { id: "PRV-MERIDIAN", code: "MER", rate: 12_000, type: "h200.8x" },
    { id: "PRV-HELIOS", code: "HEL", rate: 6_400, type: "a100.8x" },
  ];
  let n = 0;
  const add = (period: string, variance: number, resolution: string, note: string) => {
    const p = providers[n % providers.length];
    const hours = 12 + Math.floor(rand() * 90);
    const expected = hours * p.rate;
    n += 1;
    const day = String(5 + (n % 20)).padStart(2, "0");
    rows.push({
      id: "AP-H-" + String(n).padStart(3, "0"),
      providerId: p.id,
      invoiceNumber: p.code + "-" + period + "-" + String(40 + n).padStart(3, "0"),
      lineRef: p.code + "-" + period + "-" + String(40 + n).padStart(3, "0") + "-L1",
      period,
      description: p.type + " on-demand, " + hours + " h at contract rate",
      invoicedCents: expected + variance,
      expectedCents: expected,
      varianceCents: variance,
      resolution,
      resolvedBy: ACTOR.controller,
      note,
      resolvedAt: period + "-" + day + "T18:00:00.000Z",
    });
  };
  PERIODS.forEach((period, i) => {
    for (let k = 0; k < 4; k++) add(period, 0, "PAID_AS_BILLED", "Matched contract; paid.");
    for (const v of SMALL_PAID.filter((_, j) => j % PERIODS.length === i)) {
      add(period, v, "PAID_AS_BILLED", "Below the effort of a dispute; paid as billed and charged to the owning project.");
    }
    const d = DISPUTED[i];
    add(period, d.cents, d.credited ? "DISPUTED_CREDITED" : "DISPUTED_DENIED", d.note);
  });
  return rows;
}

export function seedApHistory(ctx: AppContext) {
  ctx.db.insert(erpApHistory).values(buildApHistory()).onConflictDoNothing().run();
}
