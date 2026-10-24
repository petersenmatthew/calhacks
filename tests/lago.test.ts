import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { invoiceLines, workItems } from "@/server/db/schema";
import { buildScenario, writeSourceRecords } from "@/server/sim/scenarios";
import { syncLagoInvoices, type LagoInvoice } from "@/server/sync/lago";
import { setup } from "./helpers";

const cfg = { url: "http://lago.test", apiKey: "k", providerId: "PRV-HELIOS" };

/** Lambda's invoice for one instance: a $0 plan fee and the metered GPU hours. */
function invoice(seq: number, instanceId: string, hours: number): LagoInvoice {
  return {
    lago_id: "inv-" + seq,
    sequential_id: seq,
    number: "LAM-TEST-" + seq,
    issuing_date: "2026-10-24",
    status: "finalized",
    currency: "USD",
    file_url: null,
    fees: [
      { lago_id: "fee-plan-" + seq, amount_cents: 0, units: "1.0", item: { code: "gpu-h100-8x-10000" }, external_subscription_id: instanceId + ".abc" },
      { lago_id: "fee-hours-" + seq, amount_cents: hours * 10_000, units: String(hours), precise_unit_amount: "100.0", item: { code: "gpu_hours", name: "GPU instance hours" }, external_subscription_id: instanceId + ".abc", from_datetime: "2026-10-14T08:00:00Z", to_datetime: "2026-10-24T08:00:00Z" },
    ],
  };
}

function fakeLago(invoices: LagoInvoice[]) {
  return async (url: string) => {
    const path = new URL(url).pathname;
    const body = path.endsWith("/invoices") ? { invoices } : { invoice: invoices.find((i) => path.endsWith("/" + i.lago_id)) };
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

describe("Lambda invoices from Lago", () => {
  it("starts after the invoices Lambda already issued, ingests a new one once, and never duplicates it", async () => {
    const { ctx } = setup();
    const data = buildScenario(ctx, "overbilling");
    writeSourceRecords(ctx, data);
    const instanceId = data.instances[0].id;
    const issued = [invoice(1, instanceId, 24)];
    const lines = () => ctx.db.select().from(invoiceLines).where(eq(invoiceLines.instanceId, instanceId)).all();

    // A new database (first boot or demo reset) does not re-import old invoices.
    expect(await syncLagoInvoices(ctx, cfg, fakeLago(issued))).toBeNull();
    expect(lines()).toHaveLength(0);

    issued.push(invoice(2, instanceId, 36));
    const summary = await syncLagoInvoices(ctx, cfg, fakeLago(issued));
    expect(summary).toMatchObject({ pulled: 1, created: 1, cursor: "2" });
    const [line] = lines();
    expect(line).toMatchObject({ externalLineId: "LAM-TEST-2-L1", quantity: 36, unitPriceCents: 10_000, amountCents: 360_000 });
    expect(ctx.db.select().from(workItems).where(eq(workItems.invoiceLineId, line.id)).get()?.title).toContain("billed past instance lifetime");

    expect(await syncLagoInvoices(ctx, cfg, fakeLago(issued))).toMatchObject({ pulled: 0 });
    expect(lines()).toHaveLength(1);
  });
});
