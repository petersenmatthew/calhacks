import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import { createAppContext, type AppContext } from "@/server/context";
import { Orchestrator } from "@/server/orchestrator";
import { seedEnvironment } from "@/server/sim/seed";
import { approvalRequests, proposals, workItems } from "@/server/db/schema";

export function setup(file = ":memory:", config: Parameters<typeof createAppContext>[0]["config"] = {}) {
  const ctx = createAppContext({ file, config: { stepDelayMs: 0, llmAvailable: false, ...config } });
  seedEnvironment(ctx);
  const orchestrator = new Orchestrator(ctx);
  return { ctx, orchestrator };
}

export function tempDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "experiment-ledger-"));
  return path.join(dir, "test.db");
}

export function workItem(ctx: AppContext, id: string) {
  const row = ctx.db.select().from(workItems).where(eq(workItems.id, id)).get();
  if (!row) throw new Error("missing " + id);
  return row;
}

export function proposalsFor(ctx: AppContext, id: string) {
  return ctx.db.select().from(proposals).where(eq(proposals.workItemId, id)).all().sort((a, b) => a.version - b.version);
}

export function pendingApprovals(ctx: AppContext, id: string) {
  return ctx.db.select().from(approvalRequests).where(eq(approvalRequests.workItemId, id)).all().filter((a) => a.status === "PENDING");
}

export function accountBalance(ctx: AppContext, code: string) {
  const row = ctx.sqlite
    .prepare("SELECT COALESCE(SUM(credit_cents - debit_cents), 0) AS bal FROM journal_lines WHERE account_code = ?")
    .get(code) as { bal: number };
  return row.bal;
}

export function unbalancedEntries(ctx: AppContext) {
  return ctx.sqlite
    .prepare("SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING SUM(debit_cents) <> SUM(credit_cents)")
    .all();
}

export function projectExpense(ctx: AppContext, projectId: string, entryIds?: string[]) {
  const rows = ctx.sqlite
    .prepare("SELECT entry_id, debit_cents - credit_cents AS amt FROM journal_lines WHERE account_code = '6100' AND project_id = ?")
    .all(projectId) as { entry_id: string; amt: number }[];
  return rows.filter((r) => !entryIds || entryIds.includes(r.entry_id)).reduce((s, r) => s + r.amt, 0);
}
