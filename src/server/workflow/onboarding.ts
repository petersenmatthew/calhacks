import { and, eq, inArray } from "drizzle-orm";
import { recordActivity } from "../activity";
import type { AppContext } from "../context";
import { erpApHistory, jobs, policies } from "../db/schema";
import { ACTOR } from "../security/actors";
import { enqueueJob } from "./jobs";
import { POLICY_KEYS } from "./policies";

/**
 * Onboarding is not tied to an invoice: the Policy Analyst reads the company's
 * history before its first close. Its runs, evidence, and approval requests
 * are filed under this id instead of a work item.
 */
export const ONBOARDING_ID = "ONBOARDING";

export const MATERIALITY_POLICY_KEY = POLICY_KEYS.materiality;

export function isOnboarding(workItemId: string | null | undefined) {
  return workItemId === ONBOARDING_ID;
}

/** Queue the onboarding run if there is history to learn from and nothing learned or queued yet. */
export function scheduleOnboarding(ctx: AppContext) {
  const history = ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM erp_ap_history").get() as { n: number };
  if (history.n === 0) return false;
  const learned = ctx.db
    .select({ id: policies.id })
    .from(policies)
    .where(and(eq(policies.policyKey, MATERIALITY_POLICY_KEY), inArray(policies.status, ["PROPOSED", "APPROVED"])))
    .get();
  if (learned) return false;
  const queued = ctx.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.workItemId, ONBOARDING_ID), inArray(jobs.status, ["queued", "running"])))
    .get();
  if (queued) return false;
  recordActivity(ctx, {
    workItemId: ONBOARDING_ID,
    actorId: ACTOR.orchestrator,
    type: "SYSTEM",
    status: "info",
    title: "Onboarding: Policy Analyst assigned to learn AP practice from " + history.n + " historical invoice lines",
  });
  enqueueJob(ctx, { workItemId: ONBOARDING_ID, kind: "AGENT_RUN", agentId: ACTOR.policy, payload: { trigger: "onboarding" } });
  return true;
}

export function historyRows(ctx: AppContext, providerId?: string | null) {
  const q = ctx.db.select().from(erpApHistory);
  return providerId ? q.where(eq(erpApHistory.providerId, providerId)).all() : q.all();
}
