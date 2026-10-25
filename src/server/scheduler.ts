import { recordActivity } from "./activity";
import type { AppContext } from "./context";
import { ACTOR } from "./security/actors";
import { syncHttpFeed, syncSimulatedFeeds, type SyncSummary } from "./sync/feeds";
import { runFollowUps } from "./workflow/follow-ups";
import { dispatchOutbox } from "./comms/dispatch";
import { pollVendorInbox } from "./comms/inbox";
import { runMockVendor } from "./workflow/mock-vendor";

/*
 * The part of the system that starts work on its own. On every tick it pulls
 * new lines from the billing feeds, reads vendor replies from the AP mailbox,
 * and runs the time-based follow-up rules.
 * Agent work it creates goes onto the same durable job queue as everything
 * else, so a crash or redeploy never loses it.
 */

export interface ScheduledResult {
  feeds: SyncSummary[];
  followUps: number;
}

export async function runScheduledWork(ctx: AppContext, options: { feedUrl?: string | null } = {}): Promise<ScheduledResult> {
  const feeds: SyncSummary[] = [];
  let followUps = 0;
  try {
    feeds.push(...syncSimulatedFeeds(ctx));
    if (options.feedUrl) {
      const http = await syncHttpFeed(ctx, options.feedUrl);
      if (http) feeds.push(http);
    }
  } catch (error) {
    report(ctx, "Feed sync failed", error);
  }
  try {
    followUps = runFollowUps(ctx);
  } catch (error) {
    report(ctx, "Follow-up rules failed", error);
  }
  try {
    await pollVendorInbox(ctx);
  } catch (error) {
    report(ctx, "Could not read vendor replies from the mailbox", error);
  }
  // No mailbox connected: a simulated provider answers disputes. It runs in the background so a
  // model call never holds up the rest of the tick; it keeps one reply in flight per dispute.
  void runMockVendor(ctx).catch((error) => report(ctx, "The simulated vendor could not reply", error));
  try {
    await dispatchOutbox(ctx);
  } catch (error) {
    report(ctx, "Message delivery failed", error);
  }
  return { feeds, followUps };
}

let lastReported = "";

function report(ctx: AppContext, title: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === lastReported) return;
  lastReported = message;
  try {
    recordActivity(ctx, { actorId: ACTOR.scheduler, type: "ERROR", status: "error", title, summary: message });
  } catch {
    /* tables may be mid-reset */
  }
}
