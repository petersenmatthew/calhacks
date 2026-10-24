import { and, eq, inArray } from "drizzle-orm";
import { CHANNELS } from "@/server/comms/directory";
import { dispatchOutbox } from "@/server/comms/dispatch";
import { postSlack, queueEmail } from "@/server/comms/outbox";
import { resolveSlackChannel, slackApi, verifyEmail } from "@/server/comms/transports";
import { tx } from "@/server/context";
import { outbox } from "@/server/db/schema";
import { getContext } from "@/server/runtime";

export const dynamic = "force-dynamic";

async function diagnose() {
  const ctx = getContext();
  const c = ctx.config.comms;
  const slack: Record<string, unknown> = { configured: Boolean(c.slackBotToken), userIds: c.slackUserIds };
  if (c.slackBotToken) {
    try {
      const { json, scopes } = await slackApi(ctx, "auth.test");
      slack.workspace = json.team;
      slack.bot = json.user;
      slack.scopes = scopes;
      const needed = ["chat:write", "chat:write.public", "channels:read", "channels:manage", "channels:join"];
      slack.missingScopes = needed.filter((s) => !scopes.includes(s));
      slack.channels = [];
      for (const ch of CHANNELS) {
        try {
          const r = await resolveSlackChannel(ctx, ch.name);
          (slack.channels as unknown[]).push({ name: ch.name, ok: true, id: r.id, created: r.created });
        } catch (e) {
          (slack.channels as unknown[]).push({ name: ch.name, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch (e) {
      slack.error = e instanceof Error ? e.message : String(e);
    }
  }
  const failed = ctx.db.select().from(outbox).where(eq(outbox.status, "failed")).all();
  return {
    slack,
    email: { ...(await verifyEmail(ctx)), vendorEmail: c.vendorEmail, from: c.emailFrom },
    outbox: {
      failed: failed.length,
      recentErrors: [...new Set(failed.map((f) => f.lastError))].slice(0, 5),
    },
  };
}

/** Is Slack and email connected? Open /api/comms/check in the browser. */
export async function GET() {
  return Response.json(await diagnose());
}

/** Retry failed messages and send one test message to Slack and to the vendor inbox. */
export async function POST() {
  const ctx = getContext();
  tx(ctx, () => {
    ctx.db.update(outbox).set({ status: "pending", attempts: 0, lastError: null }).where(and(eq(outbox.status, "failed"), inArray(outbox.channel, ["slack", "email"]))).run();
    postSlack(ctx, { channel: "finance-ops", event: "comms.test", text: "Ledger is connected. Pings for Atlas Research finance will land in these channels." });
    if (ctx.config.comms.vendorEmail) {
      queueEmail(ctx, {
        to: ctx.config.comms.vendorEmail,
        subject: "[TEST] ExperimentLedger email is connected",
        text: "This is a test from ExperimentLedger. Vendor disputes and follow-ups will arrive at this address.",
        event: "comms.test",
      });
    }
  });
  for (let i = 0; i < 10; i++) if ((await dispatchOutbox(ctx)) === 0) break;
  return Response.json(await diagnose());
}
