import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { verifyAuditChain } from "./audit";
import type { AppContext } from "./context";
import {
  activityEvents,
  actors,
  agentRuns,
  approvalRequests,
  auditEvents,
  computeJobs,
  evidence,
  experiments,
  findings,
  gpuInstances,
  invoiceLines,
  invoices,
  jobs,
  journalEntries,
  journalLines,
  ledgerAccounts,
  lifecycleEvents,
  policies,
  projects,
  proposals,
  providerUsage,
  providers,
  reconciliations,
  vendorDisputes,
  vendorMessages,
  workItems,
  workItemTransitions,
} from "./db/schema";
import { ACTOR } from "./security/actors";
import { getAgentSettings, getExecutionMode } from "./settings";
import { toolsForAgent } from "./agents/tools";
import { contractForProvider, reservationUsage } from "./workflow/checks";
import { policyFitForWorkItem, POLICY_KEYS } from "./workflow/policies";
import { businessNowIso, clockOffsetMs } from "./clock";
import { followUps } from "./db/schema";
import { feedStatus } from "./sync/feeds";
import { FOLLOW_UP_RULES } from "./workflow/follow-ups";
import { ONBOARDING_ID } from "./workflow/onboarding";

function lookups(ctx: AppContext) {
  const projectRows = ctx.db.select().from(projects).all();
  const actorRows = ctx.db.select().from(actors).all();
  const providerRows = ctx.db.select().from(providers).all();
  return {
    projects: Object.fromEntries(projectRows.map((p) => [p.id, { id: p.id, name: p.name, lead: p.lead }])),
    actors: Object.fromEntries(actorRows.map((a) => [a.id, { id: a.id, name: a.name, kind: a.kind, role: a.role, title: a.title }])),
    providers: Object.fromEntries(providerRows.map((p) => [p.id, { id: p.id, name: p.name, shortName: p.shortName }])),
  };
}

export function getSettingsView(ctx: AppContext) {
  return {
    mode: getExecutionMode(ctx),
    llmAvailable: ctx.config.llmAvailable,
    model: ctx.config.model,
    stepDelayMs: ctx.config.stepDelayMs,
  };
}

export function getAgentStatuses(ctx: AppContext) {
  return [ACTOR.compute, ACTOR.finance, ACTOR.vendorLiaison, ACTOR.budget, ACTOR.policy, ACTOR.capacity].map((agentId) => {
    const running = ctx.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, agentId), eq(agentRuns.status, "running")))
      .orderBy(desc(agentRuns.startedAt))
      .get();
    const queued = ctx.db
      .select({ id: jobs.id, workItemId: jobs.workItemId })
      .from(jobs)
      .where(and(eq(jobs.agentId, agentId), eq(jobs.status, "queued")))
      .all();
    const latestEvent = ctx.db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.actorId, agentId))
      .orderBy(desc(activityEvents.id))
      .get();
    const latestFinding = ctx.db
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.actorId, agentId), inArray(activityEvents.type, ["FINDING", "PROPOSAL", "POLICY"])))
      .orderBy(desc(activityEvents.id))
      .get();
    const completedRuns = ctx.sqlite
      .prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE agent_id = ? AND status = 'completed'")
      .get(agentId) as { n: number };
    const runTools = running
      ? (
          ctx.sqlite
            .prepare("SELECT tool_name AS tool FROM activity_events WHERE run_id = ? AND tool_name IS NOT NULL ORDER BY id")
            .all(running.id) as { tool: string }[]
        ).map((r) => r.tool)
      : [];
    return {
      agentId,
      status: running ? "working" : queued.length ? "queued" : "idle",
      paused: getAgentSettings(ctx, agentId).paused,
      currentTask: running?.task ?? null,
      currentWorkItemId: running?.workItemId ?? queued[0]?.workItemId ?? null,
      currentMode: running?.mode ?? null,
      runId: running?.id ?? null,
      runTools,
      queued: queued.length,
      completedRuns: completedRuns.n,
      latestAction: latestEvent ? { title: latestEvent.title, at: latestEvent.createdAt, workItemId: latestEvent.workItemId } : null,
      latestFinding: latestFinding
        ? { title: latestFinding.title, summary: latestFinding.summary, at: latestFinding.createdAt, workItemId: latestFinding.workItemId }
        : null,
    };
  });
}

export function getStatus(ctx: AppContext) {
  const pending = ctx.db.select({ id: approvalRequests.id }).from(approvalRequests).where(eq(approvalRequests.status, "PENDING")).all();
  const needsInfo = ctx.db.select({ id: workItems.id }).from(workItems).where(eq(workItems.state, "NEEDS_INFO")).all();
  const open = ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM work_items WHERE state != 'RESOLVED'").get() as { n: number };
  return {
    agents: getAgentStatuses(ctx),
    settings: getSettingsView(ctx),
    pendingApprovals: pending.length,
    needsInfo: needsInfo.length,
    openItems: open.n,
  };
}

function nextBusinessDay5(period: string) {
  const [y, m] = period.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  let business = 0;
  while (true) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) business += 1;
    if (business === 5) break;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

export function getDashboard(ctx: AppContext, requestedPeriod?: string | null) {
  const periods = (ctx.sqlite.prepare("SELECT DISTINCT period FROM invoice_lines ORDER BY period DESC").all() as { period: string }[]).map(
    (r) => r.period,
  );
  const period = requestedPeriod && periods.includes(requestedPeriod) ? requestedPeriod : periods[0] ?? "2026-10";
  const lines = ctx.db.select().from(invoiceLines).where(eq(invoiceLines.period, period)).all();
  const recs = ctx.db.select().from(reconciliations).where(eq(reconciliations.period, period)).all();
  const items = ctx.db.select().from(workItems).orderBy(desc(workItems.updatedAt)).all();
  const pending = ctx.db.select().from(approvalRequests).where(eq(approvalRequests.status, "PENDING")).all();
  const totalSpend = lines.reduce((s, l) => s + l.amountCents, 0);
  const resolved = recs.filter((r) => r.status === "RESOLVED");
  const reconciledCents = resolved.reduce((s, r) => s + r.invoicedCents, 0);
  const periodItems = items.filter((i) => i.period === period);
  const open = periodItems.filter((i) => i.state !== "RESOLVED");
  const overcharges = periodItems.filter((i) => i.type === "BILLING_VARIANCE" && i.state !== "RESOLVED" && i.discrepancyCents >= 100);
  const blockers = open.filter((i) => i.state !== "DISPUTED");
  const disputed = open.filter((i) => i.state === "DISPUTED");
  const providerCount = new Set(lines.map((l) => l.invoiceId.split("-")[1])).size;
  const toolCalls = ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE tool_name IS NOT NULL").get() as { n: number };
  const runs = ctx.sqlite
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN mode = 'llm' THEN 1 ELSE 0 END), 0) AS llm FROM agent_runs")
    .get() as { n: number; llm: number };

  return {
    period,
    periods,
    metrics: {
      agentToolCalls: toolCalls.n,
      agentRuns: runs.n,
      agentLlmRuns: runs.llm,
      totalSpendCents: totalSpend,
      lineCount: lines.length,
      providerCount,
      reconciledCents,
      reconciledPct: totalSpend ? reconciledCents / totalSpend : 0,
      unresolvedCount: open.length,
      unresolvedAmountCents: open.reduce((s, i) => s + i.amountCents, 0),
      potentialOverchargeCents: overcharges.reduce((s, i) => s + i.discrepancyCents, 0),
      potentialOverchargeCount: overcharges.length,
      pendingApprovals: pending.length,
      completedReconciliations: resolved.length,
      autoMatched: resolved.filter((r) => r.outcome === "AUTO_MATCHED").length,
      monthClose: {
        status: open.length === 0 ? "READY" : blockers.length === 0 ? "AWAITING_VENDORS" : "IN_PROGRESS",
        blockers: blockers.length,
        disputesOpen: disputed.length,
        target: nextBusinessDay5(period),
      },
    },
    workItems: items.map((i) => ({
      id: i.id,
      type: i.type,
      title: i.title,
      period: i.period,
      providerId: i.providerId,
      resource: i.instanceId ?? i.reservationId,
      ownerProjectId: i.ownerProjectId,
      amountCents: i.amountCents,
      discrepancyCents: i.discrepancyCents,
      state: i.state,
      priority: i.priority,
      assignedAgentId: i.assignedAgentId,
      latestAction: i.latestAction,
      outcome: i.outcome,
      updatedAt: i.updatedAt,
      createdAt: i.createdAt,
      // A question from the Vendor Liaison while the case is open with the vendor also waits on you.
      pendingApproval: pending.some((p) => p.workItemId === i.id) || (i.state === "DISPUTED" && Boolean(i.pendingQuestion)),
    })),
    activity: ctx.db.select().from(activityEvents).orderBy(desc(activityEvents.id)).limit(30).all(),
    agents: getAgentStatuses(ctx),
    settings: getSettingsView(ctx),
    /** Policy proposals that are not tied to a work item (learned at onboarding). */
    policyApprovals: pending
      .filter((a) => a.subjectType === "POLICY" && a.workItemId === ONBOARDING_ID)
      .map((a) => {
        const policy = ctx.db.select().from(policies).where(eq(policies.id, a.subjectId)).get();
        return { approvalId: a.id, policyId: a.subjectId, title: policy?.title ?? a.subjectId, summary: a.summary, createdAt: a.createdAt };
      }),
    clock: { now: businessNowIso(ctx), offsetMs: clockOffsetMs(ctx) },
    ...lookups(ctx),
  };
}

/** What the system does on its own: feeds, the business clock, follow-ups, onboarding. */
export function getAutonomy(ctx: AppContext) {
  const onboardingRuns = ctx.db.select().from(agentRuns).where(eq(agentRuns.workItemId, ONBOARDING_ID)).orderBy(asc(agentRuns.startedAt)).all();
  const onboardingApprovals = ctx.db.select().from(approvalRequests).where(eq(approvalRequests.workItemId, ONBOARDING_ID)).all();
  const learned = ctx.db.select().from(policies).where(eq(policies.policyKey, POLICY_KEYS.materiality)).orderBy(asc(policies.version)).all();
  return {
    clock: { now: businessNowIso(ctx), offsetMs: clockOffsetMs(ctx) },
    scheduler: { intervalMs: ctx.config.schedulerIntervalMs, externalFeed: Boolean(ctx.config.feedUrl) },
    feeds: feedStatus(ctx),
    rules: FOLLOW_UP_RULES,
    followUps: ctx.db.select().from(followUps).orderBy(desc(followUps.id)).limit(40).all(),
    onboarding: {
      runs: onboardingRuns,
      approvals: onboardingApprovals,
      policies: learned,
      activity: ctx.db.select().from(activityEvents).where(eq(activityEvents.workItemId, ONBOARDING_ID)).orderBy(asc(activityEvents.id)).all(),
    },
    ...lookups(ctx),
  };
}

export function getWorkspace(ctx: AppContext, id: string) {
  const item = ctx.db.select().from(workItems).where(eq(workItems.id, id)).get();
  if (!item) return null;
  const line = ctx.db.select().from(invoiceLines).where(eq(invoiceLines.id, item.invoiceLineId)).get() ?? null;
  const invoice = line ? ctx.db.select().from(invoices).where(eq(invoices.id, line.invoiceId)).get() ?? null : null;
  const contract = contractForProvider(ctx, item.providerId);

  let instance = null;
  let lifecycle: (typeof lifecycleEvents.$inferSelect)[] = [];
  let usage: (typeof providerUsage.$inferSelect)[] = [];
  let jobRows: (typeof computeJobs.$inferSelect)[] = [];
  let experimentRows: (typeof experiments.$inferSelect)[] = [];
  let reservation = null;
  let reservationUsageView = null;
  let policyFit = null;

  if (item.instanceId) {
    instance = ctx.db.select().from(gpuInstances).where(eq(gpuInstances.id, item.instanceId)).get() ?? null;
    lifecycle = ctx.db.select().from(lifecycleEvents).where(eq(lifecycleEvents.instanceId, item.instanceId)).orderBy(asc(lifecycleEvents.occurredAt)).all();
    usage = ctx.db.select().from(providerUsage).where(eq(providerUsage.instanceId, item.instanceId)).all();
    jobRows = ctx.db.select().from(computeJobs).where(eq(computeJobs.instanceId, item.instanceId)).all();
  }
  if (item.reservationId) {
    const u = reservationUsage(ctx, item.reservationId);
    reservation = u.reservation;
    jobRows = u.jobs;
    reservationUsageView = {
      reservedGpuHours: u.reservedGpuHours,
      usedGpuHours: u.usedGpuHours,
      idleGpuHours: u.idleGpuHours,
      usageByProject: u.usageByProject,
    };
    const { policy, fit } = policyFitForWorkItem(ctx, item);
    policyFit = { policy, fit };
  }
  const expIds = [...new Set(jobRows.map((j) => j.experimentId))];
  if (expIds.length) experimentRows = ctx.db.select().from(experiments).where(inArray(experiments.id, expIds)).all();

  const proposalRows = ctx.db.select().from(proposals).where(eq(proposals.workItemId, id)).orderBy(asc(proposals.version)).all();
  const approvals = ctx.db.select().from(approvalRequests).where(eq(approvalRequests.workItemId, id)).orderBy(asc(approvalRequests.createdAt)).all();
  const policyIds = approvals.filter((a) => a.subjectType === "POLICY").map((a) => a.subjectId);
  const policyKey = item.type === "SHARED_ALLOCATION" ? POLICY_KEYS.sharedReservation : POLICY_KEYS.explainedVariance;
  const relatedPolicies = ctx.db
    .select()
    .from(policies)
    .where(eq(policies.policyKey, policyKey))
    .orderBy(asc(policies.version))
    .all()
    .concat(policyIds.length ? ctx.db.select().from(policies).where(inArray(policies.id, policyIds)).all() : [])
    .filter((p, i, arr) => arr.findIndex((x) => x.id === p.id) === i);
  const entries = ctx.db.select().from(journalEntries).where(eq(journalEntries.invoiceLineId, item.invoiceLineId)).orderBy(asc(journalEntries.postedAt)).all();
  const entryLines = entries.length
    ? ctx.db.select().from(journalLines).where(inArray(journalLines.entryId, entries.map((e) => e.id))).orderBy(asc(journalLines.lineNo)).all()
    : [];
  const apOutstanding = entryLines.filter((l) => l.accountCode === "2000").reduce((s, l) => s + l.creditCents - l.debitCents, 0);

  return {
    item,
    line,
    invoice,
    contract,
    instance,
    lifecycle,
    usage,
    jobs: jobRows,
    experiments: experimentRows,
    reservation,
    reservationUsage: reservationUsageView,
    policyFit,
    findings: ctx.db.select().from(findings).where(eq(findings.workItemId, id)).orderBy(asc(findings.createdAt)).all(),
    evidence: ctx.db.select().from(evidence).where(eq(evidence.workItemId, id)).orderBy(asc(evidence.createdAt)).all(),
    proposals: proposalRows,
    approvals,
    policies: relatedPolicies,
    runs: ctx.db.select().from(agentRuns).where(eq(agentRuns.workItemId, id)).orderBy(asc(agentRuns.startedAt)).all(),
    transitions: ctx.db.select().from(workItemTransitions).where(eq(workItemTransitions.workItemId, id)).orderBy(asc(workItemTransitions.id)).all(),
    activity: ctx.db.select().from(activityEvents).where(eq(activityEvents.workItemId, id)).orderBy(asc(activityEvents.id)).all(),
    journal: entries.map((e) => ({ ...e, lines: entryLines.filter((l) => l.entryId === e.id) })),
    apOutstandingCents: apOutstanding,
    dispute: ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, id)).get() ?? null,
    /** Vendor replies and the Vendor Liaison's answers, oldest first. */
    vendorMessages: ctx.db.select().from(vendorMessages).where(eq(vendorMessages.workItemId, id)).orderBy(asc(vendorMessages.receivedAt)).all(),
    agents: getAgentStatuses(ctx),
    settings: getSettingsView(ctx),
    ...lookups(ctx),
  };
}

export function getAuditView(ctx: AppContext) {
  const events = ctx.db.select().from(auditEvents).orderBy(desc(auditEvents.id)).limit(600).all();
  const entries = ctx.db.select().from(journalEntries).orderBy(desc(journalEntries.postedAt)).limit(200).all();
  const lines = entries.length
    ? ctx.db.select().from(journalLines).where(inArray(journalLines.entryId, entries.map((e) => e.id))).orderBy(asc(journalLines.lineNo)).all()
    : [];
  const trial = ctx.sqlite
    .prepare(
      "SELECT a.code AS code, a.name AS name, a.type AS type, COALESCE(SUM(l.debit_cents), 0) AS debits, COALESCE(SUM(l.credit_cents), 0) AS credits FROM ledger_accounts a LEFT JOIN journal_lines l ON l.account_code = a.code GROUP BY a.code ORDER BY a.code",
    )
    .all() as { code: string; name: string; type: string; debits: number; credits: number }[];
  const counts = ctx.sqlite
    .prepare("SELECT outcome, COUNT(*) AS n FROM audit_events GROUP BY outcome")
    .all() as { outcome: string; n: number }[];
  return {
    events,
    chain: verifyAuditChain(ctx),
    counts: Object.fromEntries(counts.map((c) => [c.outcome, c.n])),
    policies: ctx.db.select().from(policies).orderBy(asc(policies.policyKey), asc(policies.version)).all(),
    journal: entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entryId === e.id) })),
    trialBalance: trial,
    accounts: ctx.db.select().from(ledgerAccounts).all(),
    ...lookups(ctx),
  };
}

export type DashboardData = ReturnType<typeof getDashboard>;
export type WorkspaceData = NonNullable<ReturnType<typeof getWorkspace>>;
export type AuditData = ReturnType<typeof getAuditView>;

/** Types of activity that count as something an employee produced. */
const OUTPUT_TYPES = ["FINDING", "HANDOFF", "PROPOSAL", "POLICY", "DISPUTE", "COMPLETED", "POSTING"];

/** Everything the canvas sidebar shows for one employee. */
export function getAgentView(ctx: AppContext, agentId: string) {
  const actor = ctx.db.select().from(actors).where(eq(actors.id, agentId)).get();
  if (!actor || actor.kind !== "agent") return null;
  const status = getAgentStatuses(ctx).find((a) => a.agentId === agentId) ?? null;
  const runs = ctx.db.select().from(agentRuns).where(eq(agentRuns.agentId, agentId)).orderBy(desc(agentRuns.startedAt)).all();
  const itemIds = [...new Set(runs.map((r) => r.workItemId))];
  const items = itemIds.length ? ctx.db.select().from(workItems).where(inArray(workItems.id, itemIds)).all() : [];
  const tasks = itemIds.slice(0, 8).map((id) => {
    const item = items.find((i) => i.id === id)!;
    const mine = runs.filter((r) => r.workItemId === id);
    return {
      id,
      title: item?.title ?? id,
      state: item?.state ?? "UNKNOWN",
      runs: mine.length,
      lastRunStatus: mine[0]?.status ?? null,
      lastAction: mine[0]?.terminalAction ?? null,
      at: mine[0]?.startedAt ?? null,
    };
  });
  const outputs = ctx.db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.actorId, agentId), inArray(activityEvents.type, OUTPUT_TYPES)))
    .orderBy(desc(activityEvents.id))
    .limit(8)
    .all()
    .map((e) => ({ id: e.id, workItemId: e.workItemId, title: e.title, type: e.type, at: e.createdAt }));
  const toolCalls = ctx.sqlite.prepare("SELECT COUNT(*) AS n FROM activity_events WHERE actor_id = ? AND tool_name IS NOT NULL").get(agentId) as { n: number };
  return {
    id: actor.id,
    name: actor.name,
    title: actor.title,
    description: actor.description,
    status,
    settings: getAgentSettings(ctx, agentId),
    execution: getSettingsView(ctx),
    tools: toolsForAgent(agentId).map((t) => ({ name: t.name, description: t.description, terminal: Boolean(t.terminal) })),
    totals: { runs: runs.length, completed: runs.filter((r) => r.status === "completed").length, toolCalls: toolCalls.n },
    tasks,
    outputs,
  };
}

export type AgentView = NonNullable<ReturnType<typeof getAgentView>>;
export type StatusData = ReturnType<typeof getStatus>;
export type AutonomyData = ReturnType<typeof getAutonomy>;
export type AgentStatus = ReturnType<typeof getAgentStatuses>[number];
export type ActivityRow = typeof activityEvents.$inferSelect;
