import fs from "node:fs";
import path from "node:path";
import { createAppContext } from "@/server/context";
import { seedEnvironment } from "@/server/sim/seed";
import { runScenarioLive } from "@/server/sim/live";
import { OdooClient, odooLinks, syncOdoo } from "@/server/sync/odoo";

/*
 * npm run sandboxes:check
 * End-to-end check against the running sandboxes (npm run sandboxes:up), on an
 * in-memory database. Lambda bills two instances in Lago (one overbilled, one
 * exact), the app pulls the invoices, and every resulting entry is recorded in
 * Odoo. Prints what each real system now holds.
 */
function sandboxEnv(key: string) {
  if (process.env[key]) return process.env[key];
  const file = path.join(process.cwd(), "sandboxes", ".env");
  const line = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").find((l) => l.startsWith(key + "=")) : undefined;
  return line?.slice(key.length + 1);
}

async function main() {
  const lago = { url: process.env.LAGO_API_URL || "http://localhost:3100", apiKey: sandboxEnv("LAGO_API_KEY") ?? "", providerId: "PRV-HELIOS" };
  const odoo = { url: process.env.ODOO_URL || "http://localhost:8069", db: process.env.ODOO_DB || "atlas", user: process.env.ODOO_USER || "admin", password: process.env.ODOO_PASSWORD || "admin" };
  if (!lago.apiKey) throw new Error("No Lago API key. Run npm run sandboxes:up first.");
  const ctx = createAppContext({ file: ":memory:", config: { lago, odoo } });
  seedEnvironment(ctx, "demo");

  const over = await runScenarioLive(ctx, "overbilling");
  console.log("Overbilled instance:", JSON.stringify(over));
  const exact = await runScenarioLive(ctx, "custom", { providerId: "PRV-HELIOS", projectId: "PRJ-RLA", provisionedHours: 10, jobHours: 9.5, billedHours: 10 });
  console.log("Exact instance:     ", JSON.stringify(exact));

  for (let i = 0; i < 30; i += 1) {
    const { recorded, failed } = await syncOdoo(ctx, odoo, lago);
    const waiting = ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM erp_links WHERE document = 'pending'").get() as { n: number };
    if (!recorded && !failed && !waiting.n) break;
    if (!recorded && !failed) await new Promise((r) => setTimeout(r, 1000));
  }
  const links = odooLinks(ctx);
  const failed = links.filter((l) => l.status !== "synced");
  const odooError = ctx.sqlite.prepare("SELECT last_error FROM sync_cursors WHERE source = 'odoo-erp'").get() as { last_error: string | null } | undefined;
  if (odooError?.last_error) console.log("Odoo error:", odooError.last_error);
  console.log("Recorded in Odoo:   ", links.length - failed.length, "entries;", failed.length, "failed");
  for (const f of failed) console.log("  failed", f.entryId, f.lastError);

  const client = new OdooClient(odoo);
  const ids = links.filter((l) => l.odooId).map((l) => l.odooId!);
  const moves = await client.call<{ name: string; move_type: string; partner_id: [number, string] | false; amount_total: number; ref: string | false; state: string }[]>(
    "account.move",
    "read",
    [ids.slice(-6)],
    { fields: ["name", "move_type", "partner_id", "amount_total", "ref", "state"] },
  );
  for (const m of moves) console.log("  ", m.name, m.move_type, m.state, m.partner_id ? m.partner_id[1] : "", "$" + m.amount_total, m.ref || "");
  const bills = links.filter((l) => l.kind === "vendor_bill" && l.odooId).map((l) => l.odooId!);
  const pdfs = await client.call<number>("ir.attachment", "search_count", [[["res_model", "=", "account.move"], ["res_id", "in", bills], ["mimetype", "=", "application/pdf"]]]);
  console.log("Lambda PDFs attached to bills:", pdfs);

  const ok = over.status === "work_item_created" && exact.status === "auto_matched" && links.length > 0 && failed.length === 0 && pdfs > 0;
  console.log(ok ? "\nPASS" : "\nFAIL");
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
