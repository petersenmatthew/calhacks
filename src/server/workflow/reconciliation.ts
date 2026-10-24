import { eq } from "drizzle-orm";
import { nowIso, type AppContext } from "../context";
import { reconciliations, workItems } from "../db/schema";

export function resolveReconciliation(ctx: AppContext, invoiceLineId: string, outcome: string) {
  ctx.db
    .update(reconciliations)
    .set({ status: "RESOLVED", outcome, resolvedAt: nowIso() })
    .where(eq(reconciliations.invoiceLineId, invoiceLineId))
    .run();
}

export function setReconciliationOutcome(ctx: AppContext, invoiceLineId: string, outcome: string) {
  ctx.db.update(reconciliations).set({ outcome }).where(eq(reconciliations.invoiceLineId, invoiceLineId)).run();
}

export function setWorkItemOutcome(ctx: AppContext, workItemId: string, outcome: string) {
  ctx.db.update(workItems).set({ outcome, updatedAt: nowIso() }).where(eq(workItems.id, workItemId)).run();
}
