import { recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { nowIso, type AppContext } from "../context";
import { syncCursors } from "../db/schema";
import { ACTOR } from "../security/actors";
import { authorize } from "../security/authorize";
import { isControlError } from "../security/errors";
import type { ScenarioData } from "../sim/scenarios";
import { ingestBillingEvent, type BillingEvent, type IngestionResult } from "../workflow/ingestion";
import { eq } from "drizzle-orm";

/*
 * Lambda's billing system, running for real in Lago (sandboxes/docker-compose.yml).
 *
 * Each GPU instance is a Lago subscription on a per-GPU-hour plan. Lambda's
 * meter sends the hours as a usage event, and ending the subscription makes
 * Lago issue the invoice, with its own number, fees, and PDF. Atlas never
 * writes invoices: the scheduler pulls finalized invoices from Lago's API on a
 * cursor and sends each fee through the normal ingestion pipeline.
 */

export interface LagoConfig {
  url: string;
  apiKey: string;
  /** The provider whose billing runs in Lago. */
  providerId: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export const LAGO_SOURCE = "lago-lambda-billing";
export const LAGO_CUSTOMER = "atlas-research";
const METRIC = "gpu_hours";

interface LagoFee {
  lago_id: string;
  amount_cents: number;
  units: string | number;
  precise_unit_amount?: string;
  from_datetime?: string | null;
  to_datetime?: string | null;
  external_subscription_id?: string | null;
  item?: { type?: string; code?: string; name?: string };
}

export interface LagoInvoice {
  lago_id: string;
  sequential_id: number;
  number: string;
  issuing_date: string;
  status: string;
  currency: string;
  file_url?: string | null;
  fees?: LagoFee[];
}

export class LagoError extends Error {}

async function call<T>(cfg: LagoConfig, method: string, path: string, body?: unknown, fetcher: Fetcher = fetch): Promise<T> {
  const res = await fetcher(cfg.url.replace(/\/$/, "") + "/api/v1" + path, {
    method,
    headers: { Authorization: "Bearer " + cfg.apiKey, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new LagoError("Lago " + method + " " + path + " -> " + res.status + " " + text.slice(0, 300));
  return (text ? JSON.parse(text) : {}) as T;
}

async function exists(cfg: LagoConfig, path: string, fetcher: Fetcher) {
  try {
    return await call<Record<string, unknown>>(cfg, "GET", path, undefined, fetcher);
  } catch (error) {
    if (error instanceof LagoError && / -> 404 /.test(error.message)) return null;
    throw error;
  }
}

/** Instance types Lambda sells, as plans on its price list. */
function planCode(instanceType: string, rateCents: number) {
  return "gpu-" + instanceType.replace(/[^a-z0-9]+/gi, "-") + "-" + rateCents;
}

function gpuLabel(instanceType: string) {
  const [gpu, count] = instanceType.split(".");
  return (count ?? "").replace("x", "") + "x " + gpu.toUpperCase();
}

const ensured = new Set<string>();

/** Lambda's catalog: the GPU-hour meter, the Atlas customer account, and a plan per instance type and rate. */
export async function ensureLagoCatalog(cfg: LagoConfig, instanceType: string, rateCents: number, fetcher: Fetcher = fetch) {
  const code = planCode(instanceType, rateCents);
  if (ensured.has(cfg.url + code)) return code;
  let metric = (await exists(cfg, "/billable_metrics/" + METRIC, fetcher)) as { billable_metric: { lago_id: string } } | null;
  if (!metric) {
    metric = await call(cfg, "POST", "/billable_metrics", {
      billable_metric: {
        name: "GPU instance hours",
        code: METRIC,
        description: "Hours an instance was billed, as metered by Lambda",
        aggregation_type: "sum_agg",
        field_name: "hours",
        recurring: false,
      },
    }, fetcher);
  }
  await call(cfg, "POST", "/customers", {
    customer: { external_id: LAGO_CUSTOMER, name: "Atlas Research", email: "ap@atlas-research.example", currency: "USD", timezone: "UTC" },
  }, fetcher);
  if (!(await exists(cfg, "/plans/" + code, fetcher))) {
    await call(cfg, "POST", "/plans", {
      plan: {
        name: gpuLabel(instanceType) + " on demand",
        code,
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "USD",
        pay_in_advance: false,
        charges: [
          {
            billable_metric_id: metric!.billable_metric.lago_id,
            charge_model: "standard",
            pay_in_advance: false,
            invoiceable: true,
            properties: { amount: (rateCents / 100).toFixed(2) },
          },
        ],
      },
    }, fetcher);
  }
  ensured.add(cfg.url + code);
  return code;
}

/** True when this case's invoice should come from Lago rather than the built-in simulator. */
export function billsThroughLago(cfg: LagoConfig | null, data: ScenarioData) {
  return Boolean(cfg && data.event.invoice.providerId === cfg.providerId && data.event.line.lineType === "instance" && data.instances.length === 1);
}

/**
 * What Lambda's systems do when an instance ends: open the subscription at
 * provisioning time, send the metered hours, and terminate it, which makes
 * Lago issue the invoice.
 */
export async function billInstanceInLago(cfg: LagoConfig, data: ScenarioData, fetcher: Fetcher = fetch) {
  const instance = data.instances[0];
  const line = data.event.line;
  const code = await ensureLagoCatalog(cfg, instance.instanceType, line.unitPriceCents, fetcher);
  // Instance ids repeat after a demo reset; Lago subscription ids must not.
  const externalId = instance.id + "." + Date.now().toString(36);
  const startedAt = data.lifecycle.find((e) => e.eventType === "PROVISIONED")?.occurredAt ?? data.event.line.serviceStart;
  await call(cfg, "POST", "/subscriptions", {
    subscription: { external_customer_id: LAGO_CUSTOMER, plan_code: code, external_id: externalId, name: instance.id, subscription_at: startedAt },
  }, fetcher);
  const meteredUntil = Math.min(Date.now(), Date.parse(startedAt) + line.quantity * 3_600_000);
  await call(cfg, "POST", "/events", {
    event: {
      transaction_id: externalId + ":hours",
      external_subscription_id: externalId,
      code: METRIC,
      timestamp: Math.floor(meteredUntil / 1000),
      properties: { hours: line.quantity, instance_id: instance.id },
    },
  }, fetcher);
  await call(cfg, "DELETE", "/subscriptions/" + encodeURIComponent(externalId), undefined, fetcher);
  return { externalSubscriptionId: externalId, planCode: code };
}

function instanceIdFrom(externalSubscriptionId: string | null | undefined) {
  return externalSubscriptionId ? externalSubscriptionId.replace(/\.[a-z0-9]+$/, "") : null;
}

function isGpuHourFee(fee: LagoFee) {
  return fee.item?.code === METRIC && Number(fee.units) > 0 && fee.amount_cents > 0;
}

/** One Lago fee becomes one invoice line, in the shape every feed uses. */
export function feeToBillingEvent(cfg: LagoConfig, invoice: LagoInvoice, fee: LagoFee, index: number): BillingEvent | null {
  if (!isGpuHourFee(fee)) return null;
  const units = Number(fee.units);
  const instanceId = instanceIdFrom(fee.external_subscription_id);
  const unitPriceCents = fee.precise_unit_amount ? Math.round(Number(fee.precise_unit_amount) * 100) : Math.round(fee.amount_cents / units);
  const period = invoice.issuing_date.slice(0, 7);
  const issuedAt = invoice.issuing_date.length === 10 ? invoice.issuing_date + "T00:00:00.000Z" : invoice.issuing_date;
  return {
    externalEventId: "lago:" + fee.lago_id,
    source: LAGO_SOURCE,
    invoice: { id: "INV-" + invoice.number, providerId: cfg.providerId, invoiceNumber: invoice.number, period, issuedAt },
    line: {
      id: invoice.number + "-L" + (index + 1),
      externalLineId: invoice.number + "-L" + (index + 1),
      lineType: "instance",
      instanceId,
      reservationId: null,
      description: (fee.item?.name ?? "GPU instance hours") + " " + (instanceId ?? "") + ": " + units + " h at $" + (unitPriceCents / 100).toFixed(2) + "/h",
      quantity: units,
      unit: "hour",
      unitPriceCents,
      amountCents: fee.amount_cents,
      period,
      serviceStart: fee.from_datetime ?? issuedAt,
      serviceEnd: fee.to_datetime ?? issuedAt,
    },
    document: { issuer: "Lago", invoiceId: invoice.lago_id, url: invoice.file_url ?? null, subscriptionId: fee.external_subscription_id ?? null },
  };
}

export interface LagoSyncSummary {
  source: string;
  pulled: number;
  created: number;
  autoMatched: number;
  duplicates: number;
  failed: number;
  cursor: string | null;
}

function writeCursor(ctx: AppContext, cursor: string | null, pulled: number, error: string | null) {
  const prev = ctx.db.select().from(syncCursors).where(eq(syncCursors.source, LAGO_SOURCE)).get();
  const values = { cursor, syncedAt: nowIso(), lastCount: pulled, totalCount: (prev?.totalCount ?? 0) + pulled, lastError: error };
  ctx.db.insert(syncCursors).values({ source: LAGO_SOURCE, ...values }).onConflictDoUpdate({ target: syncCursors.source, set: values }).run();
}

async function listInvoices(cfg: LagoConfig, fetcher: Fetcher) {
  const list = await call<{ invoices: LagoInvoice[] }>(cfg, "GET", "/invoices?external_customer_id=" + LAGO_CUSTOMER + "&status=finalized&per_page=100", undefined, fetcher);
  return list.invoices;
}

/**
 * A new Atlas database (first boot or demo reset) starts reading after the
 * newest invoice Lambda has already issued, the way a new integration starts
 * from "now" instead of re-importing history.
 */
export async function ensureLagoBaseline(ctx: AppContext, cfg: LagoConfig, fetcher: Fetcher = fetch) {
  if (ctx.db.select().from(syncCursors).where(eq(syncCursors.source, LAGO_SOURCE)).get()) return false;
  const latest = (await listInvoices(cfg, fetcher)).reduce((m, i) => Math.max(m, i.sequential_id), 0);
  writeCursor(ctx, String(latest), 0, null);
  return true;
}

/**
 * Pull finalized invoices Lambda issued to Atlas since the cursor (Lago's
 * per-customer sequential id) and ingest every GPU-hour fee on them.
 */
export async function syncLagoInvoices(ctx: AppContext, cfg: LagoConfig, fetcher: Fetcher = fetch): Promise<LagoSyncSummary | null> {
  authorize(ctx, ACTOR.scheduler, "feed:sync");
  try {
    if (await ensureLagoBaseline(ctx, cfg, fetcher)) return null;
  } catch (error) {
    writeCursor(ctx, null, 0, error instanceof Error ? error.message : String(error));
    return null;
  }
  const prev = ctx.db.select().from(syncCursors).where(eq(syncCursors.source, LAGO_SOURCE)).get();
  const after = Number(prev?.cursor ?? 0);
  let fresh: LagoInvoice[];
  try {
    fresh = (await listInvoices(cfg, fetcher)).filter((i) => i.sequential_id > after).sort((a, b) => a.sequential_id - b.sequential_id);
  } catch (error) {
    writeCursor(ctx, prev?.cursor ?? null, 0, error instanceof Error ? error.message : String(error));
    return null;
  }
  const summary: LagoSyncSummary = { source: LAGO_SOURCE, pulled: 0, created: 0, autoMatched: 0, duplicates: 0, failed: 0, cursor: prev?.cursor ?? null };
  if (!fresh.length) {
    writeCursor(ctx, summary.cursor, 0, null);
    return summary;
  }
  let lastError: string | null = null;
  const numbers: string[] = [];
  for (const head of fresh) {
    let invoice: LagoInvoice;
    try {
      invoice = (await call<{ invoice: LagoInvoice }>(cfg, "GET", "/invoices/" + head.lago_id, undefined, fetcher)).invoice;
    } catch (error) {
      // Stop here so the cursor never skips an invoice we could not read.
      lastError = error instanceof Error ? error.message : String(error);
      break;
    }
    numbers.push(invoice.number);
    (invoice.fees ?? []).filter(isGpuHourFee).forEach((fee, i) => {
      const event = feeToBillingEvent(cfg, invoice, fee, i);
      if (!event) return;
      summary.pulled += 1;
      try {
        tally(summary, ingestBillingEvent(ctx, event));
      } catch (error) {
        summary.failed += 1;
        lastError = error instanceof Error ? error.message : String(error);
        if (!isControlError(error) || !error.recorded) recordFailure(ctx, event.line.externalLineId, lastError);
      }
    });
    summary.cursor = String(invoice.sequential_id);
  }
  writeCursor(ctx, summary.cursor, summary.pulled, lastError);
  if (numbers.length) {
    appendAudit(ctx, {
      actorId: ACTOR.scheduler,
      action: "feed.sync",
      category: "system",
      targetType: "feed",
      targetId: LAGO_SOURCE,
      details: { from: prev?.cursor ?? null, to: summary.cursor, invoices: numbers, ...summary },
    });
    recordActivity(ctx, {
      actorId: ACTOR.scheduler,
      type: "INGESTION",
      status: summary.failed ? "error" : "ok",
      title: "Pulled Lambda invoice " + numbers.join(", ") + " from Lago",
      summary:
        [summary.created ? summary.created + " opened for investigation" : null, summary.autoMatched ? summary.autoMatched + " auto-matched" : null, summary.duplicates ? summary.duplicates + " already processed" : null, summary.failed ? summary.failed + " failed" : null]
          .filter(Boolean)
          .join(", ") + ". Cursor " + (prev?.cursor ?? "start") + " -> " + summary.cursor + ".",
    });
  }
  return summary;
}

function tally(summary: LagoSyncSummary, result: IngestionResult) {
  if (result.status === "work_item_created") summary.created += 1;
  else if (result.status === "auto_matched") summary.autoMatched += 1;
  else summary.duplicates += 1;
}

function recordFailure(ctx: AppContext, ref: string, message: string) {
  appendAudit(ctx, {
    actorId: ACTOR.scheduler,
    action: "feed.sync.line_failed",
    outcome: "FAILED",
    category: "system",
    targetType: "feed_event",
    targetId: ref,
    details: { source: LAGO_SOURCE, error: message },
  });
}

/**
 * The PDF Lambda issued for an invoice, or null while Lago is still rendering
 * it. Lago's storage link redirects to an https URL even on a plain-http local
 * install, so redirects to the Lago host keep the configured protocol.
 */
export async function lagoInvoicePdf(cfg: LagoConfig, lagoInvoiceId: string, fetcher: Fetcher = fetch): Promise<Buffer | null> {
  let url = (await call<{ invoice: LagoInvoice }>(cfg, "GET", "/invoices/" + lagoInvoiceId, undefined, fetcher)).invoice.file_url ?? null;
  if (!url) {
    await call(cfg, "POST", "/invoices/" + lagoInvoiceId + "/download", undefined, fetcher);
    return null;
  }
  const base = new URL(cfg.url);
  for (let hop = 0; hop < 4; hop += 1) {
    const target = new URL(url, base);
    if (target.host === base.host) target.protocol = base.protocol;
    const res = await fetcher(target.toString(), { redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = res.headers.get("location")!;
      continue;
    }
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  return null;
}
