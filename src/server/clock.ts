import { eq } from "drizzle-orm";
import { recordActivity } from "./activity";
import { appendAudit } from "./audit";
import { notifyChange, type AppContext } from "./context";
import { settings } from "./db/schema";
import { ACTOR } from "./security/actors";
import { authorize, guard } from "./security/authorize";
import { ControlError } from "./security/errors";

/*
 * Business clock. Finance runs over weeks, so time-based behaviour (approval
 * reminders, vendor chases, feed publication) is measured against this clock.
 * In production the offset is zero and it is plain wall-clock time; the demo
 * can move it forward to show what the system does after days pass.
 */

const KEY = "clock_offset_ms";
const HISTORY_KEY = "clock_history";

type Change = { at: string; offsetMs: number };

function history(ctx: AppContext): Change[] {
  const row = ctx.db.select().from(settings).where(eq(settings.key, HISTORY_KEY)).get();
  return Array.isArray(row?.value) ? (row.value as Change[]) : [];
}
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function clockOffsetMs(ctx: AppContext): number {
  const row = ctx.db.select().from(settings).where(eq(settings.key, KEY)).get();
  return typeof row?.value === "number" ? row.value : 0;
}

export function businessNow(ctx: AppContext): Date {
  return new Date(Date.now() + clockOffsetMs(ctx));
}

export function businessNowIso(ctx: AppContext) {
  return businessNow(ctx).toISOString();
}

/** Business time at the moment a row was written (rows are stamped with wall-clock time). */
export function businessTimeOf(ctx: AppContext, iso: string) {
  const wall = Date.parse(iso);
  let offset = 0;
  for (const change of history(ctx)) if (Date.parse(change.at) < wall) offset = change.offsetMs;
  return wall + offset;
}

/** How long ago, in business time, a row was written. */
export function businessAgeMs(ctx: AppContext, iso: string) {
  return businessNow(ctx).getTime() - businessTimeOf(ctx, iso);
}

export function formatDuration(ms: number) {
  const days = ms / DAY_MS;
  if (days >= 1) {
    const d = Math.floor(days);
    return d + (d === 1 ? " day" : " days");
  }
  const hours = Math.max(1, Math.floor(ms / HOUR_MS));
  return hours + (hours === 1 ? " hour" : " hours");
}

/** Demo control: move the business clock forward. Audited like any other change. */
export function advanceClock(ctx: AppContext, actorId: string, hours: number) {
  return guard(ctx, { actorId, action: "clock.advance" }, () => {
    authorize(ctx, actorId, "clock:advance");
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) {
      throw new ControlError("Advance between 1 hour and 90 days", "INVALID_INPUT", "FAILED");
    }
    const next = clockOffsetMs(ctx) + Math.round(hours * HOUR_MS);
    ctx.db
      .insert(settings)
      .values({ key: KEY, value: next })
      .onConflictDoUpdate({ target: settings.key, set: { value: next } })
      .run();
    const changes = [...history(ctx), { at: new Date().toISOString(), offsetMs: next }];
    ctx.db
      .insert(settings)
      .values({ key: HISTORY_KEY, value: changes })
      .onConflictDoUpdate({ target: settings.key, set: { value: changes } })
      .run();
    appendAudit(ctx, { actorId, action: "clock.advance", category: "system", details: { hours, offsetMs: next } });
    recordActivity(ctx, {
      actorId: ACTOR.orchestrator,
      type: "SYSTEM",
      status: "info",
      title: "Business clock moved forward " + formatDuration(hours * HOUR_MS) + " (demo)",
      summary: "Now " + businessNow(ctx).toISOString().slice(0, 16).replace("T", " ") + " UTC. Scheduled syncs and follow-ups run against this clock.",
    });
    notifyChange(ctx, "clock");
    return { offsetMs: next, now: businessNowIso(ctx) };
  });
}
