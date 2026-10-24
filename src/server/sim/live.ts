import { eq } from "drizzle-orm";
import { appendAudit } from "../audit";
import { sleep, type AppContext } from "../context";
import { journalEntries } from "../db/schema";
import { ACTOR } from "../security/actors";
import { billInstanceInLago, billsThroughLago, ensureLagoBaseline, LAGO_SOURCE, syncLagoInvoices } from "../sync/lago";
import { buildScenario, ingestCase, runScenario, writeSourceRecords, type CustomScenarioParams, type ScenarioKey } from "./scenarios";

export type LiveScenarioResult =
  | ReturnType<typeof runScenario>
  | { status: "sent_to_provider"; workItemId: null; invoiceLineId: null; provider: string };

/**
 * The Simulate button. With Lago configured, a Lambda instance charge is billed
 * by Lambda's real billing system: Atlas's own records are written, Lambda's
 * meter sends the hours to Lago, and Lago issues the invoice. The app then
 * pulls that invoice like any other feed. Other scenarios use the simulator.
 */
export async function runScenarioLive(ctx: AppContext, key: ScenarioKey, params?: CustomScenarioParams): Promise<LiveScenarioResult> {
  const cfg = ctx.config.lago;
  if (!cfg || key === "duplicate") return runScenario(ctx, key, params);
  const data = buildScenario(ctx, key, params);
  if (!billsThroughLago(cfg, data)) return ingestCase(ctx, data);

  writeSourceRecords(ctx, data);
  const instanceId = data.instances[0].id;
  await ensureLagoBaseline(ctx, cfg);
  const billed = await billInstanceInLago(cfg, data);
  appendAudit(ctx, {
    actorId: ACTOR.simulator,
    action: "simulator.provider_metered_usage",
    category: "system",
    targetType: "gpu_instance",
    targetId: instanceId,
    details: {
      note: "Lambda's meter sent the billed hours to Lambda's billing system (Lago) and the instance was terminated there. Lago issues the invoice.",
      lagoSubscription: billed.externalSubscriptionId,
      plan: billed.planCode,
      hours: data.event.line.quantity,
    },
  });

  // Lago issues the invoice in the background, usually within a few seconds.
  for (let i = 0; i < 20; i += 1) {
    await sleep(750);
    await syncLagoInvoices(ctx, cfg);
    const event = ctx.sqlite
      .prepare("SELECT invoice_line_id AS lineId, work_item_id AS workItemId, outcome FROM ingestion_events WHERE source = ? AND json_extract(payload, '$.document.subscriptionId') = ?")
      .get(LAGO_SOURCE, billed.externalSubscriptionId) as { lineId: string; workItemId: string | null; outcome: string } | undefined;
    if (!event) continue;
    const line = { id: event.lineId };
    if (event.outcome === "work_item_created" && event.workItemId) {
      return { status: "work_item_created", workItemId: event.workItemId, invoiceLineId: line.id };
    }
    if (event.outcome === "auto_matched") {
      const entry = ctx.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, "auto:" + line.id)).get();
      return { status: "auto_matched", invoiceLineId: line.id, entryId: entry?.id ?? "" };
    }
    return { status: "duplicate", workItemId: null, invoiceLineId: line.id };
  }
  return { status: "sent_to_provider", workItemId: null, invoiceLineId: null, provider: "Lambda" };
}
