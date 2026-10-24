import { and, asc, eq, lt } from "drizzle-orm";
import { recordActivity } from "../activity";
import { notifyChange, nowIso, type AppContext } from "../context";
import { outbox, vendorDisputes } from "../db/schema";
import { ACTOR } from "../security/actors";
import { sendEmail, sendSlack, type Delivery } from "./transports";

const MAX_ATTEMPTS = 5;
const BATCH = 20;

/** Deliver pending outbox messages. Safe to call repeatedly; failures are retried a few times, then reported. */
export async function dispatchOutbox(ctx: AppContext) {
  const rows = ctx.db
    .select()
    .from(outbox)
    .where(and(eq(outbox.status, "pending"), lt(outbox.attempts, MAX_ATTEMPTS)))
    // Email ("email" sorts before "slack") goes first so a vendor letter never waits behind a burst of pings.
    .orderBy(asc(outbox.channel), asc(outbox.id))
    .limit(BATCH)
    .all();
  let delivered = 0;
  for (const row of rows) {
    // Claim the row so a concurrent dispatch cannot send it twice.
    const claimed = ctx.db.update(outbox).set({ status: "sending" }).where(and(eq(outbox.id, row.id), eq(outbox.status, "pending"))).run();
    if (claimed.changes === 0) continue;
    let result: Delivery | null = null;
    let error: string | null = null;
    try {
      result =
        row.channel === "email"
          ? await sendEmail(ctx, { to: row.destination, subject: row.subject ?? "", text: row.body, html: row.html, attachments: row.attachments, headers: row.headers })
          : await sendSlack(ctx, row.destination, row.body);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const attempts = row.attempts + 1;
    const status = result ? result.status : attempts >= MAX_ATTEMPTS ? "failed" : "pending";
    ctx.db
      .update(outbox)
      .set({
        status,
        attempts,
        lastError: error,
        providerMessageId: result && result.status === "sent" ? result.id : null,
        sentAt: result ? nowIso() : null,
      })
      .where(eq(outbox.id, row.id))
      .run();
    if (row.channel === "email" && row.event === "dispute.sent" && row.ref) {
      ctx.db.update(vendorDisputes).set({ emailStatus: status === "pending" ? "retrying" : status }).where(eq(vendorDisputes.id, row.ref)).run();
    }
    if (row.channel === "email" && (status === "sent" || status === "failed")) {
      recordActivity(ctx, {
        workItemId: row.workItemId,
        actorId: ACTOR.scheduler,
        type: status === "sent" ? "SYSTEM" : "ERROR",
        status: status === "sent" ? "ok" : "error",
        title: status === "sent" ? "Emailed " + row.destination + ": " + (row.subject ?? "") : "Could not email " + row.destination + " after " + attempts + " attempts",
        summary: error,
      });
    }
    if (result) delivered += 1;
  }
  if (rows.length) notifyChange(ctx, "outbox-delivered");
  return delivered;
}

/** After a restart, messages caught mid-send go back to pending. */
export function recoverOutbox(ctx: AppContext) {
  return ctx.db.update(outbox).set({ status: "pending" }).where(eq(outbox.status, "sending")).run().changes;
}
