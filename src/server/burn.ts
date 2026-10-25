import { eq } from "drizzle-orm";
import type { AppContext } from "./context";
import { projects } from "./db/schema";

export type BurnStatus = "on_track" | "watch" | "at_risk" | "over";

const DAY = 86_400_000;

/**
 * Compute burn for a project in a period, based on when the GPUs actually ran.
 *
 * Each posted charge is spread across its invoice line's service window, so a
 * month of reserved capacity billed on day 1 counts as used day by day. The
 * month-end projection is everything already billed plus on-demand usage at its
 * month-to-date rate for the days that remain.
 */
export function projectBurn(ctx: AppContext, projectId: string, period: string) {
  const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return null;
  const rows = ctx.sqlite
    .prepare(
      "SELECT l.debit_cents - l.credit_cents AS cents, e.posted_at AS postedAt, il.service_start AS start, il.service_end AS end FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id LEFT JOIN invoice_lines il ON il.id = e.invoice_line_id WHERE l.account_code = '6100' AND l.project_id = ? AND e.period = ?",
    )
    .all(project.id, period) as { cents: number; postedAt: string; start: string | null; end: string | null }[];

  const [y, m] = period.split("-").map(Number);
  const monthStart = Date.UTC(y, m - 1, 1);
  const monthEnd = Date.UTC(y, m, 1);
  const daysInMonth = Math.round((monthEnd - monthStart) / DAY);
  const nowMs = Math.min(monthEnd, Math.max(monthStart + DAY, Date.now()));
  const elapsed = Math.max(1, Math.min(daysInMonth, Math.ceil((nowMs - monthStart) / DAY)));
  const elapsedDays = (nowMs - monthStart) / DAY;

  const charges = rows.map((r) => {
    const s = Math.min(monthEnd, Math.max(monthStart, Date.parse(r.start ?? r.postedAt)));
    const e = Math.min(monthEnd, Math.max(s, Date.parse(r.end ?? r.start ?? r.postedAt)));
    return { cents: r.cents, s, e };
  });
  const used = (c: { s: number; e: number }, t: number) => (c.e <= c.s ? (t >= c.s ? 1 : 0) : Math.min(1, Math.max(0, (t - c.s) / (c.e - c.s))));
  const usedBy = (t: number) => charges.reduce((sum, c) => sum + c.cents * used(c, t), 0);

  const posted = charges.reduce((sum, c) => sum + c.cents, 0);
  const spent = Math.round(usedBy(nowMs));
  // On-demand usage is whatever already finished running; assume it keeps its pace.
  const onDemand = charges.filter((c) => c.e <= nowMs).reduce((sum, c) => sum + c.cents, 0);
  const perDay = onDemand / elapsedDays;
  const projected = Math.round(posted + perDay * (daysInMonth - elapsedDays));

  // Cumulative spend at the end of each day: actual through today, forecast after.
  const daily: number[] = [];
  for (let d = 0; d <= daysInMonth; d++) {
    const t = monthStart + d * DAY;
    daily.push(d <= elapsed ? Math.round(usedBy(Math.min(t, nowMs))) : Math.round(usedBy(t) + perDay * (d - elapsedDays)));
  }

  const budget = project.monthlyBudgetCents;
  const remaining = budget - posted;
  const status: BurnStatus = posted > budget ? "over" : projected > budget ? "at_risk" : projected > budget * 0.9 ? "watch" : "on_track";
  // Days until the budget runs out at the current pace; null when it lasts past month end.
  const runway = remaining <= 0 ? 0 : perDay > 0 ? Math.floor(remaining / perDay) : null;
  const daysLeft = runway !== null && runway <= daysInMonth - elapsed ? runway : null;
  return { project, posted, spent, budget, remaining, projected, daysInMonth, elapsed, status, daysLeft, daily };
}
