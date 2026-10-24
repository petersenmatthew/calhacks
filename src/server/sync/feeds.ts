import { and, asc, eq, gt, lte } from "drizzle-orm";
import { recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { businessNowIso } from "../clock";
import { nowIso, type AppContext } from "../context";
import { feedEvents, syncCursors } from "../db/schema";
import { ACTOR } from "../security/actors";
import { authorize } from "../security/authorize";
import { isControlError } from "../security/errors";
import { ingestCase, type ScenarioData } from "../sim/scenarios";
import { billingEventSchema, ingestBillingEvent, type IngestionResult } from "../workflow/ingestion";

/*
 * Stateful sync of provider billing feeds. Each source keeps a cursor, so a
 * re-sync never re-reads or duplicates a line, and ingestion is idempotent on
 * the provider's event and line ids as a second guard.
 *
 * Two kinds of source:
 * - The simulated provider outbox (feed_events), which publishes invoice lines
 *   over business time together with the simulated scheduler/infra records.
 * - An HTTP feed (BILLING_FEED_URL) for a real provider adapter:
 *   GET <url>?after=<cursor> -> { events: BillingEvent[], next_cursor }.
 */

const BATCH = 25;

export interface SyncSummary {
  source: string;
  pulled: number;
  created: number;
  autoMatched: number;
  duplicates: number;
  failed: number;
  cursor: string | null;
}

const LABELS: Record<string, string> = {
  "helios-billing-feed": "Helios Cloud billing feed",
  "meridian-billing-feed": "Meridian Compute billing feed",
  "stratus-billing-feed": "Stratus GPU billing feed",
  "http-billing-feed": "HTTP billing feed",
};

export function feedLabel(source: string) {
  return LABELS[source.replace(/^prv-/, "")] ?? source;
}

function readCursor(ctx: AppContext, source: string) {
  return ctx.db.select().from(syncCursors).where(eq(syncCursors.source, source)).get() ?? null;
}

function writeCursor(ctx: AppContext, source: string, cursor: string | null, pulled: number, error: string | null) {
  const prev = readCursor(ctx, source);
  const values = {
    cursor,
    syncedAt: nowIso(),
    lastCount: pulled,
    totalCount: (prev?.totalCount ?? 0) + pulled,
    lastError: error,
  };
  ctx.db
    .insert(syncCursors)
    .values({ source, ...values })
    .onConflictDoUpdate({ target: syncCursors.source, set: values })
    .run();
}

function tally(summary: SyncSummary, result: IngestionResult) {
  if (result.status === "work_item_created") summary.created += 1;
  else if (result.status === "auto_matched") summary.autoMatched += 1;
  else summary.duplicates += 1;
}

function report(ctx: AppContext, summary: SyncSummary, from: string | null) {
  if (summary.pulled === 0) return;
  const parts = [
    summary.created ? summary.created + " opened for investigation" : null,
    summary.autoMatched ? summary.autoMatched + " auto-matched" : null,
    summary.duplicates ? summary.duplicates + " duplicate(s) ignored" : null,
    summary.failed ? summary.failed + " failed" : null,
  ].filter(Boolean);
  appendAudit(ctx, {
    actorId: ACTOR.scheduler,
    action: "feed.sync",
    category: "system",
    targetType: "feed",
    targetId: summary.source,
    details: { from, to: summary.cursor, ...summary },
  });
  recordActivity(ctx, {
    actorId: ACTOR.scheduler,
    type: "INGESTION",
    status: summary.failed ? "error" : "ok",
    title: "Synced " + summary.pulled + " new line" + (summary.pulled === 1 ? "" : "s") + " from " + feedLabel(summary.source),
    summary: parts.join(", ") + ". Cursor " + (from ?? "start") + " -> " + summary.cursor + ".",
  });
}

function recordFailure(ctx: AppContext, source: string, ref: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  appendAudit(ctx, {
    actorId: ACTOR.scheduler,
    action: "feed.sync.line_failed",
    outcome: "FAILED",
    category: "system",
    targetType: "feed_event",
    targetId: ref,
    details: { source, error: message },
  });
  recordActivity(ctx, {
    actorId: ACTOR.scheduler,
    type: "ERROR",
    status: "error",
    title: "Could not ingest " + ref + " from " + feedLabel(source),
    summary: message + " The line was set aside; the cursor moved on so the feed keeps flowing.",
  });
}

/** Pull newly published lines from the simulated provider outbox, one source at a time. */
export function syncSimulatedFeeds(ctx: AppContext): SyncSummary[] {
  authorize(ctx, ACTOR.scheduler, "feed:sync");
  const now = businessNowIso(ctx);
  const sources = ctx.sqlite.prepare("SELECT DISTINCT source FROM feed_events ORDER BY source").all() as { source: string }[];
  const out: SyncSummary[] = [];
  for (const { source } of sources) {
    const prev = readCursor(ctx, source);
    const after = Number(prev?.cursor ?? 0);
    const rows = ctx.db
      .select()
      .from(feedEvents)
      .where(and(eq(feedEvents.source, source), gt(feedEvents.seq, after), lte(feedEvents.publishAt, now)))
      .orderBy(asc(feedEvents.seq))
      .limit(BATCH)
      .all();
    if (!rows.length) continue;
    const summary: SyncSummary = { source, pulled: rows.length, created: 0, autoMatched: 0, duplicates: 0, failed: 0, cursor: prev?.cursor ?? null };
    let lastError: string | null = null;
    for (const row of rows) {
      try {
        tally(summary, ingestCase(ctx, row.payload as unknown as ScenarioData));
      } catch (error) {
        if (!isControlError(error) || !error.recorded) recordFailure(ctx, source, row.externalEventId, error);
        summary.failed += 1;
        lastError = error instanceof Error ? error.message : String(error);
      }
      summary.cursor = String(row.seq);
    }
    writeCursor(ctx, source, summary.cursor, rows.length, lastError);
    report(ctx, summary, prev?.cursor ?? null);
    out.push(summary);
  }
  return out;
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Poll an external billing feed. Source records (lifecycle, jobs, meter) must already be synced. */
export async function syncHttpFeed(ctx: AppContext, url: string, fetcher: Fetcher = fetch): Promise<SyncSummary | null> {
  authorize(ctx, ACTOR.scheduler, "feed:sync");
  const source = "http-billing-feed";
  const prev = readCursor(ctx, source);
  const target = url + (url.includes("?") ? "&" : "?") + "after=" + encodeURIComponent(prev?.cursor ?? "");
  let body: { events?: unknown[]; next_cursor?: string | null };
  try {
    const res = await fetcher(target);
    if (!res.ok) throw new Error("HTTP " + res.status);
    body = (await res.json()) as typeof body;
  } catch (error) {
    writeCursor(ctx, source, prev?.cursor ?? null, 0, error instanceof Error ? error.message : String(error));
    return null;
  }
  const events = Array.isArray(body.events) ? body.events : [];
  const summary: SyncSummary = { source, pulled: events.length, created: 0, autoMatched: 0, duplicates: 0, failed: 0, cursor: body.next_cursor ?? prev?.cursor ?? null };
  let lastError: string | null = null;
  for (const raw of events) {
    const parsed = billingEventSchema.safeParse(raw);
    const ref = parsed.success ? parsed.data.externalEventId : "malformed event";
    try {
      if (!parsed.success) throw new Error("Malformed billing event");
      tally(summary, ingestBillingEvent(ctx, parsed.data));
    } catch (error) {
      if (!isControlError(error) || !error.recorded) recordFailure(ctx, source, ref, error);
      summary.failed += 1;
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  writeCursor(ctx, source, summary.cursor, events.length, lastError);
  report(ctx, summary, prev?.cursor ?? null);
  return summary;
}

export function feedStatus(ctx: AppContext) {
  const now = businessNowIso(ctx);
  const cursors = ctx.db.select().from(syncCursors).all();
  const sources = ctx.sqlite
    .prepare(
      "SELECT source, COUNT(*) AS total, SUM(CASE WHEN publish_at <= ? THEN 1 ELSE 0 END) AS published, MIN(CASE WHEN publish_at > ? THEN publish_at END) AS next_at FROM feed_events GROUP BY source ORDER BY source",
    )
    .all(now, now) as { source: string; total: number; published: number; next_at: string | null }[];
  return sources.map((s) => {
    const c = cursors.find((x) => x.source === s.source);
    return {
      source: s.source,
      label: feedLabel(s.source),
      published: s.published,
      total: s.total,
      cursor: c?.cursor ?? null,
      syncedAt: c?.syncedAt ?? null,
      synced: c?.totalCount ?? 0,
      nextAt: s.next_at,
      lastError: c?.lastError ?? null,
    };
  });
}
