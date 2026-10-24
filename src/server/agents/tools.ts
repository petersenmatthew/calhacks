import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { ActivityType } from "../activity";
import type { AuditCategory } from "../audit";
import { nextId, nowIso, type AppContext } from "../context";
import {
  computeJobs,
  evidence,
  experiments,
  findings,
  gpuInstances,
  invoiceLines,
  invoices,
  policies,
  precedents,
  projects,
  proposals,
  providerUsage,
  providers,
  approvalRequests,
  erpApHistory,
  vendorDisputes,
  workItems,
  type AllocationLine,
  type ProposalPayload,
} from "../db/schema";
import {
  ALLOCATION_METHODS,
  allocateReservation,
  METHOD_LABELS,
  RESERVATION_METHODS,
  type AllocationMethod,
} from "../domain/allocation";
import { hoursBetween } from "../domain/billing";
import { formatCents, round2 } from "../domain/money";
import { ACTOR, getActor } from "../security/actors";
import { ControlError } from "../security/errors";
import type { Permission } from "../security/permissions";
import { createApprovalRequest } from "../workflow/approvals";
import { contractForProvider, instanceLifecycle, reservationUsage } from "../workflow/checks";
import { enqueueJob } from "../workflow/jobs";
import { allocationJournal, postJournalEntry } from "../workflow/ledger";
import {
  evaluateStandingAuthorization,
  getApprovedPolicy,
  policyFitForWorkItem,
  POLICY_KEYS,
} from "../workflow/policies";
import { resolveReconciliation, setWorkItemOutcome } from "../workflow/reconciliation";
import { assignAgent, transitionWorkItem, type WorkItemRow } from "../workflow/work-items";
import { businessAgeMs, DAY_MS, formatDuration } from "../clock";
import { followUpsFor, recordFollowUp } from "../workflow/follow-ups";
import { MATERIALITY_POLICY_KEY, ONBOARDING_ID } from "../workflow/onboarding";

export interface AgentRunContext {
  runId: string;
  agentId: string;
  workItemId: string;
  mode: "llm" | "deterministic";
  epoch: number;
  terminal: { tool: string; summary: string } | null;
  toolCalls: number;
  trigger: Record<string, unknown>;
}

export interface ToolEvidence {
  sourceType: string;
  sourceId: string;
  label: string;
  snapshot: unknown;
}

export interface ToolOutcome {
  result: Record<string, unknown>;
  evidence?: ToolEvidence[];
  title: string;
  summary?: string;
  activityType?: ActivityType;
  changes?: string[];
  terminal?: { summary: string };
}

export interface ToolContext {
  ctx: AppContext;
  run: AgentRunContext;
  item: WorkItemRow;
}

export interface ToolDefinition {
  name: string;
  agent: "compute" | "finance" | "shared";
  /** "onboarding" tools work on company history and run outside any work item. */
  scope?: "work_item" | "onboarding";
  permission: Permission;
  category: AuditCategory;
  description: string;
  terminal?: boolean;
  schema: z.ZodObject;
  handler: (tc: ToolContext, args: Record<string, unknown>) => ToolOutcome;
}

function defineTool<S extends z.ZodObject>(
  def: Omit<ToolDefinition, "schema" | "handler"> & {
    schema: S;
    handler: (tc: ToolContext, args: z.infer<S>) => ToolOutcome;
  },
): ToolDefinition {
  return def as unknown as ToolDefinition;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const workItemId = z.string().describe("The work item assigned to you, for example WI-1001.");

function fail(message: string, rule = "INVALID_INPUT"): never {
  throw new ControlError(message, rule, "FAILED");
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return "n/a";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";
}

function projectName(ctx: AppContext, id: string | null | undefined) {
  if (!id) return "unattributed";
  return ctx.db.select().from(projects).where(eq(projects.id, id)).get()?.name ?? id;
}

function requireEvidence(ctx: AppContext, item: WorkItemRow, ids: string[], min = 1) {
  const unique = [...new Set(ids)];
  if (unique.length < min) fail("Cite at least " + min + " evidence id(s) returned by your tools.", "EVIDENCE_REQUIRED");
  if (!unique.length) return unique;
  const found = ctx.db
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.workItemId, item.id), inArray(evidence.id, unique)))
    .all();
  const missing = unique.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) fail("Unknown evidence ids for " + item.id + ": " + missing.join(", "), "EVIDENCE_REQUIRED");
  return unique;
}

function latestComputeFinding(ctx: AppContext, item: WorkItemRow) {
  return ctx.db
    .select()
    .from(findings)
    .where(and(eq(findings.workItemId, item.id), eq(findings.kind, "compute")))
    .orderBy(desc(findings.createdAt))
    .get();
}

function supersedeDrafts(ctx: AppContext, item: WorkItemRow) {
  ctx.db
    .update(proposals)
    .set({ status: "SUPERSEDED", updatedAt: nowIso() })
    .where(and(eq(proposals.workItemId, item.id), eq(proposals.status, "DRAFT")))
    .run();
}

function nextProposalVersion(ctx: AppContext, item: WorkItemRow) {
  const rows = ctx.db.select().from(proposals).where(eq(proposals.workItemId, item.id)).orderBy(desc(proposals.version)).all();
  return { version: (rows[0]?.version ?? 0) + 1, previousId: rows[0]?.id ?? null };
}

function getProposal(ctx: AppContext, item: WorkItemRow, id: string) {
  const proposal = ctx.db.select().from(proposals).where(eq(proposals.id, id)).get();
  if (!proposal || proposal.workItemId !== item.id) fail("Proposal " + id + " does not belong to " + item.id, "SCOPE");
  return proposal;
}

function setProposalStatus(ctx: AppContext, id: string, status: string, authorization?: string) {
  ctx.db
    .update(proposals)
    .set({ status, updatedAt: nowIso(), ...(authorization ? { authorization } : {}) })
    .where(eq(proposals.id, id))
    .run();
}

function describeLines(ctx: AppContext, lines: AllocationLine[]) {
  return lines.map((l) => projectName(ctx, l.projectId) + " " + formatCents(l.amountCents)).join(" / ");
}

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

const getWorkItemTool = defineTool({
  name: "get_work_item",
  agent: "shared",
  permission: "workitem:read",
  category: "read",
  description:
    "Read your assigned work item: the invoice line, deterministic reconciliation checks, prior findings, proposals, controller feedback, and human input.",
  schema: z.object({ work_item_id: workItemId }),
  handler: ({ ctx, item }) => {
    const line = ctx.db.select().from(invoiceLines).where(eq(invoiceLines.id, item.invoiceLineId)).get();
    const invoice = line ? ctx.db.select().from(invoices).where(eq(invoices.id, line.invoiceId)).get() : undefined;
    const provider = ctx.db.select().from(providers).where(eq(providers.id, item.providerId)).get();
    const fs = ctx.db.select().from(findings).where(eq(findings.workItemId, item.id)).orderBy(asc(findings.createdAt)).all();
    const ps = ctx.db.select().from(proposals).where(eq(proposals.workItemId, item.id)).orderBy(asc(proposals.version)).all();
    const aps = ctx.db.select().from(approvalRequests).where(eq(approvalRequests.workItemId, item.id)).all();
    const feedback = aps
      .filter((a) => a.subjectType === "PROPOSAL" && (a.status === "REJECTED" || a.status === "CHANGES_REQUESTED"))
      .map((a) => ({
        approval_id: a.id,
        proposal_id: a.subjectId,
        decision: a.status,
        reason: a.decisionReason,
        corrected_method: a.directive,
        decided_by: getActor(ctx, a.decidedBy ?? "")?.name ?? a.decidedBy,
        decided_at: a.decidedAt,
      }));
    const checks = item.checks;
    return {
      result: {
        work_item: {
          id: item.id,
          type: item.type,
          title: item.title,
          state: item.state,
          period: item.period,
          owner_project_id: item.ownerProjectId,
        },
        amounts: {
          invoiced: formatCents(item.invoicedCents),
          contract_supported: formatCents(item.expectedCents),
          discrepancy: formatCents(item.discrepancyCents),
          invoiced_cents: item.invoicedCents,
          contract_supported_cents: item.expectedCents,
          discrepancy_cents: item.discrepancyCents,
        },
        invoice_line: line
          ? {
              id: line.id,
              invoice_number: invoice?.invoiceNumber,
              external_line_id: line.externalLineId,
              description: line.description,
              quantity: line.quantity,
              unit: line.unit,
              unit_price: formatCents(line.unitPriceCents),
              amount: formatCents(line.amountCents),
              service_start: line.serviceStart,
              service_end: line.serviceEnd,
            }
          : null,
        provider: { id: item.providerId, name: provider?.name },
        deterministic_checks: checks,
        resources: {
          instance_id: item.instanceId,
          reservation_id: item.reservationId,
          experiment_ids: checks.experimentIds,
          job_ids: checks.jobIds,
        },
        findings: fs.map((f) => ({ id: f.id, by: f.agentId, kind: f.kind, assessment: f.assessment, summary: f.summary, data: f.data })),
        proposals: ps.map((p) => ({
          id: p.id,
          kind: p.kind,
          version: p.version,
          status: p.status,
          method: p.method,
          total: formatCents(p.payload.totalCents),
          summary: p.summary,
        })),
        controller_feedback: feedback,
        pending_question: item.pendingQuestion,
      },
      evidence: line
        ? [
            {
              sourceType: "invoice_line",
              sourceId: line.id,
              label: "Invoice " + (invoice?.invoiceNumber ?? "") + " line " + line.externalLineId,
              snapshot: { ...line, invoiceNumber: invoice?.invoiceNumber },
            },
          ]
        : [],
      title: "Reviewed " + item.id + " and its reconciliation checks",
      summary: checks.flags.map((f) => f.message).join(" "),
    };
  },
});

/* ------------------------------------------------------------------ */
/* Compute Agent                                                       */
/* ------------------------------------------------------------------ */

const getInstanceLifecycle = defineTool({
  name: "get_instance_lifecycle",
  agent: "compute",
  permission: "compute:read",
  category: "read",
  description:
    "Infrastructure controller lifecycle events for a GPU instance (requested, provisioned, stop requested, terminated) with computed lifetime hours and the scheduler jobs that ran on it.",
  schema: z.object({ instance_id: z.string() }),
  handler: ({ ctx, item }, args) => {
    if (args.instance_id !== item.instanceId) fail("Instance " + args.instance_id + " is not linked to " + item.id, "SCOPE");
    const instance = ctx.db.select().from(gpuInstances).where(eq(gpuInstances.id, args.instance_id)).get();
    const line = ctx.db.select().from(invoiceLines).where(eq(invoiceLines.id, item.invoiceLineId)).get();
    const life = instanceLifecycle(ctx, args.instance_id, line?.serviceEnd ?? nowIso());
    const jobs = ctx.db.select().from(computeJobs).where(eq(computeJobs.instanceId, args.instance_id)).all();
    return {
      result: {
        instance,
        events: life.events.map((e) => ({ type: e.eventType, at: e.occurredAt, source: e.source, reference: e.reference })),
        provisioned_at: life.provisionedAt,
        terminated_at: life.terminatedAt,
        lifecycle_hours: life.lifecycleHours,
        jobs: jobs.map((j) => ({
          job_id: j.id,
          experiment_id: j.experimentId,
          started_at: j.startedAt,
          ended_at: j.endedAt,
          wall_clock_hours: round2(hoursBetween(j.startedAt, j.endedAt)),
          gpus: j.gpus,
          status: j.status,
        })),
      },
      evidence: [
        {
          sourceType: "lifecycle",
          sourceId: args.instance_id,
          label: "Lifecycle events for " + args.instance_id,
          snapshot: { instance, events: life.events },
        },
      ],
      title: "Retrieved instance lifecycle for " + args.instance_id,
      summary:
        "Provisioned " + fmtTime(life.provisionedAt) + ", terminated " + fmtTime(life.terminatedAt) + " (" +
        life.lifecycleHours + " h). " + jobs.length + " scheduler job(s) on this instance.",
    };
  },
});

const getGpuJobLogs = defineTool({
  name: "get_gpu_job_logs",
  agent: "compute",
  permission: "compute:read",
  category: "read",
  description: "GPU scheduler record and log lines for one job: start, checkpoints, completion, GPUs used.",
  schema: z.object({ job_id: z.string() }),
  handler: ({ ctx, item }, args) => {
    if (!item.checks.jobIds.includes(args.job_id)) fail("Job " + args.job_id + " is not linked to " + item.id, "SCOPE");
    const job = ctx.db.select().from(computeJobs).where(eq(computeJobs.id, args.job_id)).get();
    if (!job) fail("Unknown job " + args.job_id, "NOT_FOUND");
    const hours = round2(hoursBetween(job.startedAt, job.endedAt));
    return {
      result: { job, wall_clock_hours: hours, gpu_hours: round2(hours * job.gpus) },
      evidence: [{ sourceType: "job_log", sourceId: job.id, label: "Scheduler log " + job.id, snapshot: job }],
      title: "Retrieved GPU scheduler logs for " + job.id,
      summary: "Job ran " + hours + " h on " + job.gpus + " GPUs and " + job.status.toLowerCase() + " at " + fmtTime(job.endedAt) + ".",
    };
  },
});

const getExperiment = defineTool({
  name: "get_experiment",
  agent: "compute",
  permission: "compute:read",
  category: "read",
  description: "Experiment tracker record: name, owner, owning research project.",
  schema: z.object({ experiment_id: z.string() }),
  handler: ({ ctx, item }, args) => {
    if (!item.checks.experimentIds.includes(args.experiment_id)) fail("Experiment " + args.experiment_id + " is not linked to " + item.id, "SCOPE");
    const exp = ctx.db.select().from(experiments).where(eq(experiments.id, args.experiment_id)).get();
    if (!exp) fail("Unknown experiment " + args.experiment_id, "NOT_FOUND");
    const project = exp.projectId ? ctx.db.select().from(projects).where(eq(projects.id, exp.projectId)).get() : undefined;
    return {
      result: { experiment: exp, project: project ?? null },
      evidence: [{ sourceType: "experiment", sourceId: exp.id, label: "Experiment " + exp.name, snapshot: { ...exp, project } }],
      title: "Retrieved experiment " + exp.id,
      summary: exp.name + ", owned by " + exp.owner + " (" + (project?.name ?? "no project") + ").",
    };
  },
});

const getProviderUsage = defineTool({
  name: "get_provider_usage",
  agent: "compute",
  permission: "compute:read",
  category: "read",
  description: "The provider's own usage meter records for an instance (what the provider says it metered).",
  schema: z.object({ instance_id: z.string() }),
  handler: ({ ctx, item }, args) => {
    if (args.instance_id !== item.instanceId) fail("Instance " + args.instance_id + " is not linked to " + item.id, "SCOPE");
    const rows = ctx.db.select().from(providerUsage).where(eq(providerUsage.instanceId, args.instance_id)).all();
    const total = round2(rows.reduce((s, r) => s + r.hours, 0));
    return {
      result: { instance_id: args.instance_id, meter_records: rows, total_hours: total },
      evidence: [{ sourceType: "provider_usage", sourceId: args.instance_id, label: "Provider meter for " + args.instance_id, snapshot: rows }],
      title: "Retrieved provider usage meter for " + args.instance_id,
      summary:
        "Provider metered " + total + " h" + (rows[0] ? " from " + fmtTime(rows[0].usageStart) + " to " + fmtTime(rows[rows.length - 1].usageEnd) : "") + ".",
    };
  },
});

const getBillingTerms = defineTool({
  name: "get_billing_terms",
  agent: "compute",
  permission: "contract:read",
  category: "read",
  description:
    "Provider contract billing terms and clauses (metering increment, minimum duration, idle time, termination, reservations) plus the contract-supported charge computed by the application.",
  schema: z.object({ provider_id: z.string() }),
  handler: ({ ctx, item }, args) => {
    if (args.provider_id !== item.providerId) fail("Provider " + args.provider_id + " is not linked to " + item.id, "SCOPE");
    const contract = contractForProvider(ctx, args.provider_id);
    const checks = item.checks;
    const computed =
      checks.kind === "instance"
        ? {
            lifecycle_hours: checks.lifecycleHours,
            contract_billable_hours: checks.billableHours,
            billed_hours: checks.billedHours,
            contract_rate_per_hour: formatCents(checks.contractRateCents),
            invoiced_rate_per_hour: formatCents(checks.invoicedRateCents),
            contract_supported_charge: formatCents(checks.expectedCents),
            invoiced: formatCents(checks.invoicedCents),
            amount_not_supported_by_contract: formatCents(Math.max(0, checks.discrepancyCents)),
          }
        : {
            committed_charge: formatCents(checks.expectedCents),
            invoiced: formatCents(checks.invoicedCents),
            reservations_billed_in_full: contract.reservationsBilledInFull,
          };
    return {
      result: {
        contract: { id: contract.id, name: contract.name, effective_from: contract.effectiveFrom },
        terms: {
          billing_increment_hours: contract.billingIncrementHours,
          minimum_hours: contract.minimumHours,
          idle_running_time_billable: contract.idleBillable,
          reservations_billed_in_full: contract.reservationsBilledInFull,
        },
        clauses: contract.clauses,
        computed,
      },
      evidence: [{ sourceType: "contract", sourceId: contract.id, label: "Contract " + contract.id + " billing terms", snapshot: contract }],
      title: "Retrieved billing terms from contract " + contract.id,
      summary:
        checks.kind === "reservation"
          ? "Reserved capacity is billed in full for the term whether or not it is used; internal sharing is allowed."
          : "Billed per started " + contract.billingIncrementHours + " h, minimum " + contract.minimumHours + " h; idle running time " +
            (contract.idleBillable ? "is billable" : "is not billable") + "; billing ends at termination.",
    };
  },
});

const findRelatedExperiments = defineTool({
  name: "find_related_experiments",
  agent: "compute",
  permission: "compute:read",
  category: "read",
  description:
    "Reconstruct consumption on a GPU reservation: reservation owner and internal terms, scheduler GPU-hours by project, idle capacity, and the experiments that used it.",
  schema: z.object({ reservation_id: z.string() }),
  handler: ({ ctx, item }, args) => {
    if (args.reservation_id !== item.reservationId) fail("Reservation " + args.reservation_id + " is not linked to " + item.id, "SCOPE");
    const usage = reservationUsage(ctx, args.reservation_id);
    const r = usage.reservation;
    const share = (h: number) => Math.round((h / usage.reservedGpuHours) * 1000) / 10;
    return {
      result: {
        reservation: {
          id: r.id,
          owner_project_id: r.ownerProjectId,
          owner_project_name: projectName(ctx, r.ownerProjectId),
          requested_by: r.requestedBy,
          gpu_type: r.gpuType,
          gpu_count: r.gpuCount,
          hours: r.hours,
          rate_per_gpu_hour: formatCents(r.rateCentsPerGpuHour),
          committed: formatCents(r.committedCents),
          start_at: r.startAt,
          end_at: r.endAt,
          internal_terms: r.internalTerms,
          owner_accountable_for_idle: r.ownerAccountableForIdle,
        },
        reserved_gpu_hours: usage.reservedGpuHours,
        used_gpu_hours: usage.usedGpuHours,
        idle_gpu_hours: usage.idleGpuHours,
        usage_by_project: usage.usageByProject.map((u) => ({
          project_id: u.projectId,
          project_name: projectName(ctx, u.projectId),
          gpu_hours: u.gpuHours,
          share_of_reserved_pct: share(u.gpuHours),
        })),
        experiments: usage.experiments.map((e) => ({ id: e.id, name: e.name, project_id: e.projectId })),
        jobs: usage.jobs.map((j) => ({
          id: j.id,
          experiment_id: j.experimentId,
          gpus: j.gpus,
          started_at: j.startedAt,
          ended_at: j.endedAt,
          gpu_hours: round2(hoursBetween(j.startedAt, j.endedAt) * j.gpus),
        })),
      },
      evidence: [
        { sourceType: "reservation", sourceId: r.id, label: "Reservation " + r.id + " agreement", snapshot: r },
        {
          sourceType: "usage",
          sourceId: r.id,
          label: "Scheduler usage on " + r.id,
          snapshot: { usageByProject: usage.usageByProject, idleGpuHours: usage.idleGpuHours, jobs: usage.jobs },
        },
      ],
      title: "Reconstructed GPU consumption on reservation " + r.id,
      summary:
        usage.usageByProject.map((u) => projectName(ctx, u.projectId) + " " + u.gpuHours + " GPU-h (" + share(u.gpuHours) + "%)").join(", ") +
        ", idle " + usage.idleGpuHours + " GPU-h (" + share(usage.idleGpuHours) + "%).",
    };
  },
});

const ASSESSMENT_LABEL: Record<string, string> = {
  explained: "charge explained by lifecycle and contract",
  not_explained: "charge not supported by lifecycle and contract",
  not_applicable: "usage reconstructed for allocation",
};

const submitComputeFindings = defineTool({
  name: "submit_compute_findings",
  agent: "compute",
  permission: "findings:compute:write",
  category: "write",
  description:
    "Record your structured findings on the shared work item. The application attaches its own computed metrics. Cite evidence ids from earlier tool results.",
  schema: z.object({
    work_item_id: workItemId,
    summary: z.string().describe("Two or three factual sentences."),
    charge_assessment: z
      .enum(["explained", "not_explained", "not_applicable"])
      .describe("Instance charges: explained or not_explained. Reservations: not_applicable."),
    owner_project_id: z.string().nullable().describe("Owning research project supported by the evidence."),
    anomalies: z.array(z.object({ code: z.string(), description: z.string() })),
    clause_refs: z.array(z.string()).describe("Contract clause refs relevant to the assessment, e.g. 4.2"),
    evidence_ids: z.array(z.string()),
  }),
  handler: ({ ctx, run, item }, args) => {
    const summary = args.summary.trim().slice(0, 800);
    if (summary.length < 10) fail("Summary is too short.");
    const cited = requireEvidence(ctx, item, args.evidence_ids);
    const checks = item.checks;
    const candidates = checks.kind === "instance" ? checks.ownerProjectIds : [checks.ownerProjectId];
    if (args.owner_project_id && !candidates.includes(args.owner_project_id)) {
      fail(
        "Owner " + args.owner_project_id + " is not supported by the retrieved evidence. Candidates: " + (candidates.join(", ") || "none"),
        "EVIDENCE_REQUIRED",
      );
    }
    if (checks.kind === "instance") {
      const unexplained = checks.discrepancyCents >= 100;
      if (args.charge_assessment === "not_applicable") fail("Assess whether the instance charge is explained.");
      if (args.charge_assessment === "explained" && unexplained) {
        fail(
          "The invoice exceeds the contract-supported charge by " + formatCents(checks.discrepancyCents) + ", so it cannot be marked explained.",
          "ARITHMETIC_CHECK",
        );
      }
      if (args.charge_assessment === "not_explained" && !unexplained) {
        fail(
          "The invoice does not exceed the contract-supported charge for the instance lifetime. Running time after a job ends is billable while the instance is up.",
          "ARITHMETIC_CHECK",
        );
      }
    }
    const computed =
      checks.kind === "instance"
        ? {
            lifecycle_hours: checks.lifecycleHours,
            contract_billable_hours: checks.billableHours,
            billed_hours: checks.billedHours,
            scheduler_hours: checks.schedulerHours,
            idle_hours: checks.idleHours,
            provider_meter_hours: checks.providerMeterHours,
            expected_cents: checks.expectedCents,
            invoiced_cents: checks.invoicedCents,
            discrepancy_cents: checks.discrepancyCents,
          }
        : {
            reserved_gpu_hours: checks.reservedGpuHours,
            used_gpu_hours: checks.usedGpuHours,
            idle_gpu_hours: checks.idleGpuHours,
            usage_by_project: checks.usageByProject,
          };
    const id = nextId(ctx, "F", 5001);
    ctx.db
      .insert(findings)
      .values({
        id,
        workItemId: item.id,
        agentId: run.agentId,
        runId: run.runId,
        kind: "compute",
        summary,
        assessment: args.charge_assessment,
        data: { owner_project_id: args.owner_project_id, anomalies: args.anomalies, clause_refs: args.clause_refs, computed },
        evidenceIds: cited,
        createdAt: nowIso(),
      })
      .run();
    const changes = ["Finding " + id + " recorded"];
    if (args.owner_project_id && args.owner_project_id !== item.ownerProjectId) {
      ctx.db.update(workItems).set({ ownerProjectId: args.owner_project_id }).where(eq(workItems.id, item.id)).run();
      changes.push("Owner: " + projectName(ctx, args.owner_project_id));
    }
    return {
      result: { finding_id: id, computed },
      title: "Compute Agent recorded findings: " + ASSESSMENT_LABEL[args.charge_assessment],
      summary,
      activityType: "FINDING",
      changes,
    };
  },
});

const handoffToFinance = defineTool({
  name: "handoff_to_finance",
  agent: "compute",
  permission: "handoff:finance",
  category: "write",
  terminal: true,
  description: "Hand the work item to the Finance Agent after your findings are recorded. Ends your run.",
  schema: z.object({ work_item_id: workItemId, note: z.string() }),
  handler: ({ ctx, item }, args) => {
    if (!latestComputeFinding(ctx, item)) fail("Submit compute findings before handing off.", "WORKFLOW");
    assignAgent(ctx, item.id, ACTOR.finance);
    enqueueJob(ctx, { workItemId: item.id, kind: "AGENT_RUN", agentId: ACTOR.finance, payload: { trigger: "handoff", note: args.note } });
    return {
      result: { handed_off_to: "Finance Agent" },
      title: "Compute Agent handed off to Finance Agent",
      summary: args.note.slice(0, 500),
      activityType: "HANDOFF",
      changes: ["Assigned to Finance Agent"],
      terminal: { summary: "handed off to Finance Agent" },
    };
  },
});

const requestHumanInfo = defineTool({
  name: "request_human_info",
  agent: "compute",
  permission: "info:request",
  category: "write",
  terminal: true,
  description: "Ask the controller for information the systems of record cannot provide. Pauses the work item. Ends your run.",
  schema: z.object({ work_item_id: workItemId, question: z.string() }),
  handler: ({ ctx, run, item }, args) => {
    const question = args.question.trim().slice(0, 500);
    if (question.length < 5) fail("Question is too short.");
    transitionWorkItem(ctx, item.id, "NEEDS_INFO", run.agentId, "Information requested: " + question);
    ctx.db
      .update(workItems)
      .set({ pendingQuestion: { agentId: run.agentId, question, askedBy: run.agentId } })
      .where(eq(workItems.id, item.id))
      .run();
    return {
      result: { status: "NEEDS_INFO" },
      title: (getActor(ctx, run.agentId)?.name ?? "Agent") + " requested information from the controller",
      summary: question,
      activityType: "HANDOFF",
      changes: ["State: NEEDS_INFO"],
      terminal: { summary: "requested controller input" },
    };
  },
});

/* ------------------------------------------------------------------ */
/* Finance Agent                                                       */
/* ------------------------------------------------------------------ */

const getProjectBudget = defineTool({
  name: "get_project_budget",
  agent: "finance",
  permission: "budget:read",
  category: "read",
  description: "Monthly compute budget and month-to-date posted compute expense for a research project.",
  schema: z.object({ project_id: z.string() }),
  handler: ({ ctx, item }, args) => {
    const project = ctx.db.select().from(projects).where(eq(projects.id, args.project_id)).get();
    if (!project) fail("Unknown project " + args.project_id, "NOT_FOUND");
    const row = ctx.sqlite
      .prepare(
        "SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_code = '6100' AND l.project_id = ? AND e.period = ?",
      )
      .get(project.id, item.period) as { total: number };
    const pct = Math.round((row.total / project.monthlyBudgetCents) * 1000) / 10;
    const snapshot = {
      project,
      period: item.period,
      monthlyBudgetCents: project.monthlyBudgetCents,
      postedCents: row.total,
      remainingCents: project.monthlyBudgetCents - row.total,
    };
    return {
      result: {
        project: { id: project.id, name: project.name, lead: project.lead, cost_center: project.costCenter },
        period: item.period,
        monthly_budget: formatCents(project.monthlyBudgetCents),
        posted_to_date: formatCents(row.total),
        remaining: formatCents(project.monthlyBudgetCents - row.total),
        utilization_pct: pct,
      },
      evidence: [{ sourceType: "budget", sourceId: project.id + ":" + item.period, label: project.name + " budget " + item.period, snapshot }],
      title: "Checked " + project.name + " compute budget for " + item.period,
      summary: formatCents(row.total) + " of " + formatCents(project.monthlyBudgetCents) + " posted (" + pct + "%).",
    };
  },
});

const getAllocationPolicy = defineTool({
  name: "get_allocation_policy",
  agent: "finance",
  permission: "policy:read",
  category: "read",
  description:
    "The approved accounting policy that applies to this work item, whether it fits the reservation terms (checked by the application), and any pending policy proposals.",
  schema: z.object({ work_item_id: workItemId }),
  handler: ({ ctx, item }) => {
    if (item.type === "SHARED_ALLOCATION") {
      const { policy, fit } = policyFitForWorkItem(ctx, item);
      const versions = ctx.db
        .select()
        .from(policies)
        .where(eq(policies.policyKey, POLICY_KEYS.sharedReservation))
        .orderBy(asc(policies.version))
        .all();
      return {
        result: {
          applicable_policy: policy
            ? {
                id: policy.id,
                version: policy.version,
                title: policy.title,
                statement: policy.statement,
                method: policy.rule.method,
                method_label: METHOD_LABELS[policy.rule.method as AllocationMethod],
                auto_post_limit: formatCents(policy.rule.autoPostLimitCents),
                approved_by: getActor(ctx, policy.approvedBy ?? "")?.name ?? policy.approvedBy,
              }
            : null,
          fit_with_reservation_terms: fit,
          versions: versions.map((v) => ({ id: v.id, version: v.version, status: v.status, method: v.rule.method })),
        },
        evidence: policy
          ? [{ sourceType: "policy", sourceId: policy.id, label: "Policy " + policy.policyKey + " v" + policy.version, snapshot: policy }]
          : [],
        title: "Retrieved allocation policy " + (policy ? policy.policyKey + " v" + policy.version : "(none approved)"),
        summary: fit.consistent ? "Policy fits the reservation terms." : "Conflict: " + fit.conflicts.join(" "),
      };
    }
    const policy = getApprovedPolicy(ctx, POLICY_KEYS.explainedVariance);
    const materiality = getApprovedPolicy(ctx, MATERIALITY_POLICY_KEY);
    const threshold = materiality?.rule.thresholdCents ?? 0;
    return {
      result: {
        applicable_policy: policy
          ? {
              id: policy.id,
              version: policy.version,
              title: policy.title,
              statement: policy.statement,
              method: policy.rule.method,
              auto_post_limit: formatCents(policy.rule.autoPostLimitCents),
            }
          : null,
        conditions: policy?.rule.conditions ?? [],
        materiality_policy: materiality
          ? {
              id: materiality.id,
              version: materiality.version,
              statement: materiality.statement,
              threshold: formatCents(threshold),
              threshold_cents: threshold,
              applies_to_this_item: item.discrepancyCents > 0 && item.discrepancyCents <= threshold,
            }
          : null,
      },
      evidence: [policy, materiality]
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .map((p) => ({ sourceType: "policy", sourceId: p.id, label: "Policy " + p.policyKey + " v" + p.version, snapshot: p })),
      title: "Retrieved policy " + (policy ? policy.policyKey + " v" + policy.version : "(none)"),
      summary: policy?.statement ?? "No standing policy for explained variances.",
    };
  },
});

const searchPrecedents = defineTool({
  name: "search_precedents",
  agent: "finance",
  permission: "precedent:read",
  category: "read",
  description: "Search historical finance decisions, including controller corrections and past vendor disputes.",
  schema: z.object({ query: z.string() }),
  handler: ({ ctx }, args) => {
    const tokens = args.query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2);
    const scored = ctx.db
      .select()
      .from(precedents)
      .all()
      .map((p) => {
        const hay = (p.title + " " + p.summary + " " + p.tags.join(" ") + " " + p.kind).toLowerCase();
        return { p, score: tokens.filter((t) => hay.includes(t)).length };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || (a.p.decidedAt < b.p.decidedAt ? 1 : -1))
      .slice(0, 4);
    return {
      result: {
        query: args.query,
        matches: scored.map(({ p }) => ({
          id: p.id,
          kind: p.kind,
          decided_at: p.decidedAt,
          decided_by: getActor(ctx, p.decidedBy)?.name ?? p.decidedBy,
          title: p.title,
          summary: p.summary,
          tags: p.tags,
          details: p.details,
        })),
      },
      evidence: scored.map(({ p }) => ({ sourceType: "precedent", sourceId: p.id, label: "Precedent " + p.id + ": " + p.title, snapshot: p })),
      title: "Searched precedents: " + args.query,
      summary: scored.length ? scored.map(({ p }) => p.id + " " + p.title).join("; ") : "No matching decisions.",
    };
  },
});

const calculateCostAllocation = defineTool({
  name: "calculate_cost_allocation",
  agent: "finance",
  permission: "allocation:calculate",
  category: "read",
  description:
    "Deterministic allocation of the charge by method. Instance charges: single_owner (full invoice) or undisputed_to_owner (contract-supported amount). Shared reservations: usage_proportional, owner_pays_idle, owner_pays_all. Lines always sum exactly to the charge.",
  schema: z.object({ work_item_id: workItemId, method: z.enum(ALLOCATION_METHODS) }),
  handler: ({ ctx, item }, args) => {
    const checks = item.checks;
    let lines: AllocationLine[];
    let total: number;
    if (checks.kind === "instance") {
      if (args.method !== "single_owner" && args.method !== "undisputed_to_owner") fail("Method " + args.method + " does not apply to instance charges.");
      const owner = item.ownerProjectId;
      if (!owner) fail("The owning project is unknown. Compute findings must establish it first.", "EVIDENCE_REQUIRED");
      total = args.method === "single_owner" ? checks.invoicedCents : Math.min(checks.expectedCents, checks.invoicedCents);
      lines = [
        {
          projectId: owner,
          amountCents: total,
          weight: 1,
          basis:
            args.method === "single_owner"
              ? "Full invoiced charge"
              : "Contract-supported " + checks.billableHours + " h x " + formatCents(checks.contractRateCents),
        },
      ];
    } else {
      if (!RESERVATION_METHODS.includes(args.method)) fail("Method " + args.method + " does not apply to shared reservations.");
      total = checks.invoicedCents;
      lines = allocateReservation(args.method, {
        totalCents: total,
        ownerProjectId: checks.ownerProjectId,
        usageByProject: checks.usageByProject.filter((u) => u.projectId !== "UNATTRIBUTED"),
        idleGpuHours: checks.idleGpuHours,
      });
    }
    const sum = lines.reduce((s, l) => s + l.amountCents, 0);
    if (sum !== total) throw new Error("Allocation does not sum to total");
    const calcId = nextId(ctx, "CALC", 4001);
    return {
      result: {
        calculation_id: calcId,
        method: args.method,
        method_label: METHOD_LABELS[args.method],
        total: formatCents(total),
        lines: lines.map((l) => ({ project_id: l.projectId, project_name: projectName(ctx, l.projectId), basis: l.basis, amount: formatCents(l.amountCents) })),
        sums_exactly_to_total: true,
      },
      evidence: [
        {
          sourceType: "calculation",
          sourceId: calcId,
          label: "Calculation " + calcId + ": " + METHOD_LABELS[args.method],
          snapshot: { method: args.method, totalCents: total, lines },
        },
      ],
      title: "Calculated allocation: " + METHOD_LABELS[args.method],
      summary: describeLines(ctx, lines) + " = " + formatCents(total),
    };
  },
});

const proposeAdjustment = defineTool({
  name: "propose_adjustment",
  agent: "finance",
  permission: "proposal:create",
  category: "write",
  description:
    "Draft an allocation proposal from a calculation. The application builds the balanced journal entry and reports whether a standing policy authorizes posting without new approval.",
  schema: z.object({
    work_item_id: workItemId,
    calculation_id: z.string(),
    rationale: z.string(),
    policy_id: z.string().nullable().describe("Approved policy the proposal follows, if any."),
    evidence_ids: z.array(z.string()),
  }),
  handler: ({ ctx, run, item }, args) => {
    const calc = ctx.db
      .select()
      .from(evidence)
      .where(and(eq(evidence.workItemId, item.id), eq(evidence.sourceType, "calculation"), eq(evidence.sourceId, args.calculation_id)))
      .get();
    if (!calc) fail("Unknown calculation " + args.calculation_id + " for " + item.id, "EVIDENCE_REQUIRED");
    const snap = calc.snapshot as { method: AllocationMethod; totalCents: number; lines: AllocationLine[] };
    if (item.type === "BILLING_VARIANCE" && snap.method !== "single_owner") {
      fail("Partial allocations of an instance charge go through propose_vendor_dispute.");
    }
    if (args.policy_id) {
      const policy = ctx.db.select().from(policies).where(eq(policies.id, args.policy_id)).get();
      if (!policy || policy.status !== "APPROVED") fail("Policy " + args.policy_id + " is not approved.", "POLICY");
      if (item.type === "SHARED_ALLOCATION" && policy.rule.method !== snap.method) {
        fail("Policy " + policy.id + " uses " + policy.rule.method + ", not " + snap.method + ". Set policy_id to null if you deviate from it.", "POLICY");
      }
    }
    const cited = requireEvidence(ctx, item, args.evidence_ids, 0);
    const rationale = args.rationale.trim().slice(0, 1200);
    if (rationale.length < 10) fail("Rationale is too short.");
    supersedeDrafts(ctx, item);
    const { version, previousId } = nextProposalVersion(ctx, item);
    const fit = item.type === "SHARED_ALLOCATION" ? policyFitForWorkItem(ctx, item).fit : undefined;
    const payload: ProposalPayload = {
      method: snap.method,
      calculationId: args.calculation_id,
      allocation: snap.lines,
      totalCents: snap.totalCents,
      journalPreview: allocationJournal(snap.lines, "Allocate " + item.invoiceLineId),
      ...(fit ? { policyFit: fit } : {}),
    };
    const id = nextId(ctx, "PR", 2001);
    ctx.db
      .insert(proposals)
      .values({
        id,
        workItemId: item.id,
        kind: "ALLOCATION",
        version,
        status: "DRAFT",
        summary: METHOD_LABELS[snap.method] + ": " + describeLines(ctx, snap.lines),
        rationale,
        method: snap.method,
        policyId: args.policy_id,
        payload,
        evidenceIds: [...new Set([...cited, calc.id])],
        createdBy: run.agentId,
        supersedesId: previousId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    const standing = evaluateStandingAuthorization(ctx, item, { kind: "ALLOCATION", method: snap.method, payload });
    transitionWorkItem(ctx, item.id, "PROPOSED", run.agentId, "Allocation " + id + " v" + version + " drafted");
    return {
      result: {
        proposal_id: id,
        version,
        total: formatCents(snap.totalCents),
        standing_authorization: standing,
        next_step: standing.authorized ? "submit_for_posting" : "request_human_approval",
      },
      title: "Finance Agent proposed allocation " + id + " v" + version,
      summary:
        describeLines(ctx, snap.lines) + ". " +
        (standing.authorized ? "Covered by standing policy " + standing.policyId + "." : "Needs controller approval: " + standing.reason),
      activityType: "PROPOSAL",
      changes: ["Proposal " + id + " v" + version + " drafted"],
    };
  },
});

const proposeVendorDispute = defineTool({
  name: "propose_vendor_dispute",
  agent: "finance",
  permission: "dispute:propose",
  category: "write",
  description:
    "Draft a vendor dispute for the amount not supported by the instance lifecycle and contract. The application computes the disputed amount and allocates the undisputed amount to the owner. Requires compute findings that the charge is not explained.",
  schema: z.object({
    work_item_id: workItemId,
    rationale: z.string(),
    clause_refs: z.array(z.string()),
    evidence_ids: z.array(z.string()),
  }),
  handler: ({ ctx, run, item }, args) => {
    const checks = item.checks;
    if (item.type !== "BILLING_VARIANCE" || checks.kind !== "instance") fail("Disputes apply to instance billing variances.");
    if (checks.discrepancyCents < 100) fail("The invoice does not exceed the contract-supported charge.", "ARITHMETIC_CHECK");
    const finding = latestComputeFinding(ctx, item);
    if (!finding || finding.assessment !== "not_explained") {
      fail("Compute findings do not establish that the charge is unexplained.", "EVIDENCE_REQUIRED");
    }
    const owner = item.ownerProjectId;
    if (!owner) fail("The owning project is unknown.", "EVIDENCE_REQUIRED");
    const cited = requireEvidence(ctx, item, args.evidence_ids, 1);
    const provider = ctx.db.select().from(providers).where(eq(providers.id, item.providerId)).get();
    const undisputed = checks.expectedCents;
    const disputed = checks.discrepancyCents;
    const lines: AllocationLine[] = [
      { projectId: owner, amountCents: undisputed, weight: 1, basis: "Contract-supported " + checks.billableHours + " h" },
    ];
    const rationale = args.rationale.trim().slice(0, 1200);
    supersedeDrafts(ctx, item);
    const { version, previousId } = nextProposalVersion(ctx, item);
    const payload: ProposalPayload = {
      method: "undisputed_to_owner",
      calculationId: null,
      allocation: lines,
      totalCents: undisputed,
      journalPreview: allocationJournal(lines, "Allocate undisputed portion of " + item.invoiceLineId),
      dispute: {
        providerId: item.providerId,
        invoiceLineId: item.invoiceLineId,
        disputedCents: disputed,
        undisputedCents: undisputed,
        invoicedCents: checks.invoicedCents,
        reason: rationale,
        clauseRefs: args.clause_refs,
      },
    };
    const id = nextId(ctx, "PR", 2001);
    ctx.db
      .insert(proposals)
      .values({
        id,
        workItemId: item.id,
        kind: "VENDOR_DISPUTE",
        version,
        status: "DRAFT",
        summary: "Dispute " + formatCents(disputed) + " with " + (provider?.name ?? "vendor") + "; allocate " + formatCents(undisputed) + " to " + projectName(ctx, owner),
        rationale,
        method: "undisputed_to_owner",
        policyId: null,
        payload,
        evidenceIds: cited,
        createdBy: run.agentId,
        supersedesId: previousId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .run();
    transitionWorkItem(ctx, item.id, "PROPOSED", run.agentId, "Vendor dispute " + id + " drafted");
    return {
      result: {
        proposal_id: id,
        version,
        disputed_amount: formatCents(disputed),
        undisputed_amount: formatCents(undisputed),
        liability_note: "Accounts payable stays at " + formatCents(checks.invoicedCents) + " until the vendor issues a credit.",
        next_step: "request_human_approval",
      },
      title: "Finance Agent proposed a vendor dispute of " + formatCents(disputed),
      summary:
        "Dispute " + formatCents(disputed) + " with " + (provider?.name ?? "vendor") + " and allocate the undisputed " + formatCents(undisputed) +
        " to " + projectName(ctx, owner) + ". The liability stays until a credit is issued.",
      activityType: "PROPOSAL",
      changes: ["Proposal " + id + " v" + version + " drafted"],
    };
  },
});

const proposePolicy = defineTool({
  name: "propose_policy",
  agent: "finance",
  permission: "policy:propose",
  category: "write",
  description:
    "Propose a new version of the shared-reservation allocation policy, citing precedents (including controller corrections). Creates a controller approval request. Does not end your run.",
  schema: z.object({
    work_item_id: workItemId,
    method: z.enum(["usage_proportional", "owner_pays_idle", "owner_pays_all"]),
    statement: z.string().describe("The policy statement in plain language."),
    rationale: z.string(),
    precedent_ids: z.array(z.string()),
    evidence_ids: z.array(z.string()),
  }),
  handler: ({ ctx, run, item }, args) => {
    if (item.type !== "SHARED_ALLOCATION") fail("Allocation policies are proposed from shared-reservation work items.");
    const current = getApprovedPolicy(ctx, POLICY_KEYS.sharedReservation);
    if (current && current.rule.method === args.method) fail("Approved policy " + current.id + " already uses " + args.method + ".", "POLICY_EXISTS");
    const pending = ctx.db
      .select()
      .from(policies)
      .where(and(eq(policies.policyKey, POLICY_KEYS.sharedReservation), eq(policies.status, "PROPOSED")))
      .all()
      .find((p) => p.rule.method === args.method);
    if (pending) {
      return {
        result: { policy_id: pending.id, version: pending.version, status: "already_proposed" },
        title: "Policy " + pending.id + " is already awaiting approval",
        summary: pending.statement,
        activityType: "POLICY",
      };
    }
    const precedentRows = args.precedent_ids.length
      ? ctx.db.select().from(precedents).where(inArray(precedents.id, args.precedent_ids)).all()
      : [];
    if (precedentRows.length !== new Set(args.precedent_ids).size) fail("Unknown precedent id cited.", "EVIDENCE_REQUIRED");
    const cited = requireEvidence(ctx, item, args.evidence_ids, 0);
    const statement = args.statement.trim().slice(0, 800);
    if (statement.length < 20) fail("Policy statement is too short.");
    const all = ctx.db.select().from(policies).where(eq(policies.policyKey, POLICY_KEYS.sharedReservation)).all();
    const version = Math.max(0, ...all.map((p) => p.version)) + 1;
    const id = "POL-" + POLICY_KEYS.sharedReservation + "-v" + version;
    ctx.db
      .insert(policies)
      .values({
        id,
        policyKey: POLICY_KEYS.sharedReservation,
        version,
        title: "Shared reservation allocation",
        status: "PROPOSED",
        statement,
        rule: {
          method: args.method,
          autoPostLimitCents: current?.rule.autoPostLimitCents ?? 2_500_000,
          appliesTo: "Shared GPU reservations used by more than one project",
          conditions:
            args.method === "owner_pays_idle"
              ? [
                  "Each borrowing project pays for the GPU-hours it used at the reservation rate.",
                  "Unused reserved capacity is charged to the reserving project.",
                  "Applies when the reservation terms make the reserving team accountable for unused capacity.",
                ]
              : [METHOD_LABELS[args.method]],
        },
        rationale: args.rationale.trim().slice(0, 1200),
        evidenceIds: cited,
        precedentIds: args.precedent_ids,
        learnedFromWorkItemId: item.id,
        proposedBy: run.agentId,
        supersedesId: current?.id ?? null,
        createdAt: nowIso(),
      })
      .run();
    const approvalId = createApprovalRequest(ctx, {
      workItemId: item.id,
      subjectType: "POLICY",
      subjectId: id,
      requestedBy: run.agentId,
      summary: "Adopt " + POLICY_KEYS.sharedReservation + " v" + version + ": " + METHOD_LABELS[args.method] + ".",
    });
    return {
      result: { policy_id: id, version, approval_id: approvalId },
      title: "Finance Agent proposed reusable policy " + POLICY_KEYS.sharedReservation + " v" + version,
      summary: statement,
      activityType: "POLICY",
      changes: ["Policy " + id + " proposed", "Approval " + approvalId + " pending"],
    };
  },
});

const requestHumanApproval = defineTool({
  name: "request_human_approval",
  agent: "finance",
  permission: "approval:request",
  category: "decision",
  terminal: true,
  description: "Submit a drafted proposal for controller approval. Pauses the work item until a human decides. Ends your run.",
  schema: z.object({ work_item_id: workItemId, proposal_id: z.string(), summary: z.string() }),
  handler: ({ ctx, run, item }, args) => {
    const proposal = getProposal(ctx, item, args.proposal_id);
    if (proposal.status !== "DRAFT") fail("Proposal " + proposal.id + " is " + proposal.status + ", not DRAFT.", "STATE_MACHINE");
    setProposalStatus(ctx, proposal.id, "PENDING_APPROVAL");
    const summary = args.summary.trim().slice(0, 800) || proposal.summary;
    const approvalId = createApprovalRequest(ctx, {
      workItemId: item.id,
      subjectType: "PROPOSAL",
      subjectId: proposal.id,
      requestedBy: run.agentId,
      summary,
    });
    transitionWorkItem(ctx, item.id, "NEEDS_APPROVAL", run.agentId, "Awaiting controller decision on " + proposal.id + " v" + proposal.version);
    return {
      result: { approval_id: approvalId, status: "PENDING" },
      title: "Finance Agent submitted " + proposal.id + " v" + proposal.version + " for controller approval",
      summary,
      activityType: "TOOL_CALL",
      changes: ["Proposal " + proposal.id + " PENDING_APPROVAL"],
      terminal: { summary: "requested controller approval (" + approvalId + ")" },
    };
  },
});

const submitForPosting = defineTool({
  name: "submit_for_posting",
  agent: "finance",
  permission: "posting:request",
  category: "posting",
  terminal: true,
  description:
    "Ask the ledger gateway to post a drafted allocation under an approved standing policy. The gateway verifies the policy itself; if it does not cover the proposal the call is denied and you should request approval. Ends your run on success.",
  schema: z.object({ work_item_id: workItemId, proposal_id: z.string() }),
  handler: ({ ctx, item }, args) => {
    const proposal = getProposal(ctx, item, args.proposal_id);
    if (proposal.status !== "DRAFT" || proposal.kind !== "ALLOCATION") fail("Only drafted allocations can be submitted for posting.", "STATE_MACHINE");
    const standing = evaluateStandingAuthorization(ctx, item, proposal);
    if (!standing.authorized || !standing.policyId) {
      throw new ControlError(
        "Standing authorization does not cover " + proposal.id + ": " + standing.reason + " Request controller approval instead.",
        "APPROVAL_REQUIRED",
      );
    }
    const policy = ctx.db.select().from(policies).where(eq(policies.id, standing.policyId)).get();
    const approver = getActor(ctx, policy?.approvedBy ?? "")?.name ?? policy?.approvedBy;
    const authorization = "Standing policy " + standing.policyId + " approved by " + approver;
    setProposalStatus(ctx, proposal.id, "APPROVED", authorization);
    transitionWorkItem(ctx, item.id, "APPROVED", ACTOR.ledger, authorization);
    const { entryId } = postJournalEntry(ctx, {
      actorId: ACTOR.ledger,
      period: item.period,
      memo: "Allocate " + item.invoiceLineId + " per " + proposal.id + " v" + proposal.version,
      source: "experiment_ledger",
      authorization,
      idempotencyKey: "proposal:" + proposal.id,
      lines: proposal.payload.journalPreview,
      workItemId: item.id,
      invoiceLineId: item.invoiceLineId,
      proposalId: proposal.id,
      policyId: standing.policyId,
    });
    setProposalStatus(ctx, proposal.id, "EXECUTED");
    transitionWorkItem(ctx, item.id, "POSTED", ACTOR.ledger, "Posted " + entryId);
    const outcome =
      item.type === "SHARED_ALLOCATION"
        ? "ALLOCATED_UNDER_POLICY"
        : standing.policyId.startsWith("POL-" + MATERIALITY_POLICY_KEY)
          ? "ACCEPTED_BELOW_MATERIALITY"
          : "CHARGE_EXPLAINED";
    resolveReconciliation(ctx, item.invoiceLineId, outcome);
    setWorkItemOutcome(ctx, item.id, outcome);
    transitionWorkItem(ctx, item.id, "RESOLVED", ACTOR.orchestrator, "Reconciliation complete under " + standing.policyId);
    return {
      result: { posted: true, journal_entry_id: entryId, authorization },
      title: "Finance Agent submitted " + proposal.id + " for posting under " + standing.policyId,
      summary: "The ledger gateway verified " + standing.policyId + " and posted " + entryId + ".",
      activityType: "TOOL_CALL",
      changes: ["Journal entry " + entryId + " posted", "State: RESOLVED"],
      terminal: { summary: "posted " + entryId + " under " + standing.policyId },
    };
  },
});

const requestMoreInfo = defineTool({
  name: "request_more_info",
  agent: "finance",
  permission: "handoff:compute",
  category: "write",
  terminal: true,
  description: "Send the work item back to the Compute Agent with a specific question. Ends your run.",
  schema: z.object({ work_item_id: workItemId, question: z.string() }),
  handler: ({ ctx, run, item }, args) => {
    if (item.state === "PROPOSED") transitionWorkItem(ctx, item.id, "INVESTIGATING", run.agentId, "More compute evidence requested");
    supersedeDrafts(ctx, item);
    assignAgent(ctx, item.id, ACTOR.compute);
    enqueueJob(ctx, { workItemId: item.id, kind: "AGENT_RUN", agentId: ACTOR.compute, payload: { trigger: "finance_question", question: args.question } });
    return {
      result: { handed_off_to: "Compute Agent" },
      title: "Finance Agent asked the Compute Agent for more evidence",
      summary: args.question.slice(0, 500),
      activityType: "HANDOFF",
      changes: ["Assigned to Compute Agent"],
      terminal: { summary: "asked Compute Agent for more evidence" },
    };
  },
});

/* ------------------------------------------------------------------ */
/* Finance Agent: dispute follow-ups (started by the scheduler)        */
/* ------------------------------------------------------------------ */

function openDispute(ctx: AppContext, item: WorkItemRow) {
  const dispute = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, item.id)).get();
  if (!dispute) fail("There is no vendor dispute on " + item.id + ".", "NOT_FOUND");
  return dispute;
}

function vendorMessages(ctx: AppContext, disputeId: string) {
  return followUpsFor(ctx, disputeId)
    .filter((f) => f.kind === "VENDOR_MESSAGE")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

const getDisputeStatus = defineTool({
  name: "get_dispute_status",
  agent: "finance",
  permission: "dispute:follow_up",
  category: "read",
  description:
    "Status of the vendor dispute on your work item: amount, days open on the business clock, the contract's dispute clause, follow-ups already sent, and what is still owed.",
  schema: z.object({ work_item_id: workItemId }),
  handler: ({ ctx, item }) => {
    const dispute = openDispute(ctx, item);
    const age = businessAgeMs(ctx, dispute.submittedAt);
    const daysOpen = Math.floor(age / DAY_MS);
    const contract = contractForProvider(ctx, item.providerId);
    const clauses = contract.clauses.filter((c) => /dispute/i.test(c.title));
    const provider = ctx.db.select().from(providers).where(eq(providers.id, item.providerId)).get();
    const prior = vendorMessages(ctx, dispute.id);
    const ap = ctx.sqlite
      .prepare("SELECT COALESCE(SUM(credit_cents - debit_cents), 0) AS bal FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_code = '2000' AND e.invoice_line_id = ?")
      .get(item.invoiceLineId) as { bal: number };
    const snapshot = { ...dispute, daysOpen, apOutstandingCents: ap.bal, priorFollowUps: prior.length };
    return {
      result: {
        dispute: {
          id: dispute.id,
          status: dispute.status,
          amount: formatCents(dispute.amountCents),
          submitted_at: dispute.submittedAt,
          days_open: daysOpen,
          vendor_reference: dispute.vendorReference,
          reason: dispute.reason,
        },
        provider: { id: item.providerId, name: provider?.name },
        dispute_clauses: clauses.map((c) => ({ ref: c.ref, title: c.title, text: c.text })),
        prior_follow_ups: prior.map((f) => ({ sent_at_business_time: f.businessAt, message: (f.details as { message?: string }).message ?? "" })),
        accounts_payable_outstanding: formatCents(ap.bal),
      },
      evidence: [{ sourceType: "vendor_dispute", sourceId: dispute.id, label: "Dispute " + dispute.id + " status (day " + daysOpen + ")", snapshot }],
      title: "Checked dispute " + dispute.id + ": " + dispute.status.toLowerCase() + ", " + formatDuration(age) + " open",
      summary: prior.length ? prior.length + " follow-up(s) already sent." : "No follow-up sent yet.",
    };
  },
});

const sendVendorFollowUp = defineTool({
  name: "send_vendor_follow_up",
  agent: "finance",
  permission: "dispute:follow_up",
  category: "write",
  terminal: true,
  description:
    "Send a follow-up message to the vendor about the open dispute through the vendor portal (simulated). At most one follow-up per 7 days. Ends your run.",
  schema: z.object({
    work_item_id: workItemId,
    message: z.string().describe("The message to the vendor's billing team. Reference the dispute, amount, and contract clause."),
    evidence_ids: z.array(z.string()),
  }),
  handler: ({ ctx, run, item }, args) => {
    const dispute = openDispute(ctx, item);
    if (dispute.status !== "SUBMITTED" || item.state !== "DISPUTED") fail("Dispute " + dispute.id + " is " + dispute.status + "; nothing to chase.", "STATE_MACHINE");
    const prior = vendorMessages(ctx, dispute.id);
    const last = prior[prior.length - 1];
    if (last && businessAgeMs(ctx, last.createdAt) < 7 * DAY_MS) fail("A follow-up was already sent in the last 7 days.", "FOLLOW_UP_RATE");
    const message = args.message.trim().slice(0, 1500);
    if (message.length < 40) fail("The follow-up message is too short to be useful to the vendor.");
    const cited = requireEvidence(ctx, item, args.evidence_ids, 1);
    const provider = ctx.db.select().from(providers).where(eq(providers.id, item.providerId)).get();
    const n = prior.length + 1;
    const daysOpen = Math.floor(businessAgeMs(ctx, dispute.submittedAt) / DAY_MS);
    recordFollowUp(ctx, {
      key: "vendor-message:" + dispute.id + ":" + n,
      kind: "VENDOR_MESSAGE",
      workItemId: item.id,
      subjectId: dispute.id,
      actorId: run.agentId,
      details: { message, to: dispute.vendorReference, channel: "vendor portal (simulated)", number: n, daysOpen, evidenceIds: cited },
    });
    return {
      result: { sent: true, follow_up_number: n, channel: "vendor portal (simulated)", days_open: daysOpen },
      title: "Finance Agent followed up with " + (provider?.name ?? "the vendor") + " on " + dispute.id + " (day " + daysOpen + ", no response)",
      summary: message,
      activityType: "DISPUTE",
      changes: ["Follow-up #" + n + " sent on " + dispute.id],
      terminal: { summary: "sent follow-up #" + n + " on " + dispute.id },
    };
  },
});

const escalateDispute = defineTool({
  name: "escalate_dispute",
  agent: "finance",
  permission: "dispute:follow_up",
  category: "decision",
  terminal: true,
  description:
    "Escalate an unanswered vendor dispute to the controller with a recommended next step. Only after at least one follow-up went unanswered. Ends your run.",
  schema: z.object({
    work_item_id: workItemId,
    summary: z.string(),
    recommended_action: z.string(),
    evidence_ids: z.array(z.string()),
  }),
  handler: ({ ctx, run, item }, args) => {
    const dispute = openDispute(ctx, item);
    if (dispute.status !== "SUBMITTED") fail("Dispute " + dispute.id + " is " + dispute.status + ".", "STATE_MACHINE");
    if (vendorMessages(ctx, dispute.id).length === 0) fail("Follow up with the vendor before escalating.", "FOLLOW_UP_FIRST");
    const cited = requireEvidence(ctx, item, args.evidence_ids, 1);
    const daysOpen = Math.floor(businessAgeMs(ctx, dispute.submittedAt) / DAY_MS);
    const controller = getActor(ctx, ACTOR.controller)?.name ?? "the controller";
    recordFollowUp(ctx, {
      key: "dispute-escalation-note:" + dispute.id,
      kind: "ESCALATION_NOTE",
      workItemId: item.id,
      subjectId: dispute.id,
      actorId: run.agentId,
      details: { summary: args.summary.slice(0, 800), recommendedAction: args.recommended_action.slice(0, 800), daysOpen, evidenceIds: cited },
    });
    return {
      result: { escalated_to: controller, days_open: daysOpen },
      title: "Finance Agent escalated " + dispute.id + " to " + controller + " after " + daysOpen + " days without a vendor response",
      summary: args.summary.trim().slice(0, 600) + " Recommended: " + args.recommended_action.trim().slice(0, 400),
      activityType: "APPROVAL_REQUEST",
      changes: ["Escalation note on " + dispute.id],
      terminal: { summary: "escalated " + dispute.id + " to the controller" },
    };
  },
});

/* ------------------------------------------------------------------ */
/* Finance Agent: onboarding (learn from AP history)                   */
/* ------------------------------------------------------------------ */

const BANDS: { label: string; min: number; max: number }[] = [
  { label: "$0 (exact)", min: 0, max: 0 },
  { label: "$0.01 to $25", min: 1, max: 2_500 },
  { label: "$25.01 to $50", min: 2_501, max: 5_000 },
  { label: "$50.01 to $100", min: 5_001, max: 10_000 },
  { label: "$100.01 to $500", min: 10_001, max: 50_000 },
  { label: "over $500", min: 50_001, max: Number.MAX_SAFE_INTEGER },
];

const queryApHistory = defineTool({
  name: "query_ap_history",
  agent: "finance",
  scope: "onboarding",
  permission: "history:read",
  category: "read",
  description:
    "Mine the ERP's AP history: every past GPU invoice line, what the contract supported, the variance, and how the controller resolved it (paid as billed, disputed and credited, disputed and denied). Returns counts by variance band and resolution, computed by the application.",
  schema: z.object({
    provider_id: z.string().nullable().describe("Limit to one provider, or null for all."),
    months: z.number().int().min(1).max(12).describe("How many months back to read."),
  }),
  handler: ({ ctx }, args) => {
    const all = ctx.db.select().from(erpApHistory).all();
    const periods = [...new Set(all.map((r) => r.period))].sort().slice(-args.months);
    const rows = all.filter((r) => periods.includes(r.period) && (!args.provider_id || r.providerId === args.provider_id));
    if (!rows.length) fail("No AP history matches.", "NOT_FOUND");
    const paid = rows.filter((r) => r.resolution === "PAID_AS_BILLED");
    const credited = rows.filter((r) => r.resolution === "DISPUTED_CREDITED");
    const denied = rows.filter((r) => r.resolution === "DISPUTED_DENIED");
    const disputed = [...credited, ...denied];
    const paidVar = paid.filter((r) => r.varianceCents > 0).map((r) => r.varianceCents);
    const largestPaid = paidVar.length ? Math.max(...paidVar) : 0;
    const smallestDisputed = disputed.length ? Math.min(...disputed.map((r) => r.varianceCents)) : null;
    const smallestCredited = credited.length ? Math.min(...credited.map((r) => r.varianceCents)) : null;
    const bands = BANDS.map((b) => {
      const inBand = rows.filter((r) => r.varianceCents >= b.min && r.varianceCents <= b.max);
      return {
        band: b.label,
        lines: inBand.length,
        paid_as_billed: inBand.filter((r) => r.resolution === "PAID_AS_BILLED").length,
        disputed_credited: inBand.filter((r) => r.resolution === "DISPUTED_CREDITED").length,
        disputed_denied: inBand.filter((r) => r.resolution === "DISPUTED_DENIED").length,
      };
    });
    const stats = {
      periods: periods[0] + " to " + periods[periods.length - 1],
      lines: rows.length,
      lines_with_variance: rows.filter((r) => r.varianceCents > 0).length,
      paid_as_billed_with_variance: paidVar.length,
      disputed: disputed.length,
      disputes_credited: credited.length,
      largest_variance_paid_as_billed: formatCents(largestPaid),
      largest_variance_paid_as_billed_cents: largestPaid,
      smallest_variance_disputed: smallestDisputed === null ? null : formatCents(smallestDisputed),
      smallest_variance_disputed_cents: smallestDisputed,
      smallest_variance_credited_cents: smallestCredited,
      consistent_threshold_range_cents:
        smallestCredited !== null && largestPaid < smallestCredited ? { from: largestPaid, to: smallestCredited - 1 } : null,
    };
    const examples = [...paid.filter((r) => r.varianceCents > 0).slice(-3), ...disputed.slice(0, 3)].map((r) => ({
      id: r.id,
      line: r.lineRef,
      variance: formatCents(r.varianceCents),
      resolution: r.resolution,
      note: r.note,
    }));
    return {
      result: { stats, bands, examples },
      evidence: [
        {
          sourceType: "erp_history",
          sourceId: "AP:" + (args.provider_id ?? "ALL") + ":" + stats.periods,
          label: "ERP AP history " + stats.periods + " (" + rows.length + " lines)",
          snapshot: { stats, bands, lineIds: rows.map((r) => r.id) },
        },
      ],
      title: "Mined " + rows.length + " historical AP lines (" + stats.periods + ")",
      summary:
        paidVar.length + " variances up to " + formatCents(largestPaid) + " were paid as billed; " + disputed.length +
        " disputes started at " + (smallestDisputed === null ? "n/a" : formatCents(smallestDisputed)) + " (" + credited.length + " credited).",
    };
  },
});

const proposeMaterialityPolicy = defineTool({
  name: "propose_materiality_policy",
  agent: "finance",
  scope: "onboarding",
  permission: "policy:propose",
  category: "write",
  terminal: true,
  description:
    "Propose a written materiality policy that matches how the controller has actually resolved variances: invoice variances at or below the threshold are accepted and charged to the owning project; larger ones are disputed. The application checks the threshold against history. Creates a controller approval request. Ends your run.",
  schema: z.object({
    threshold_cents: z.number().int().positive(),
    statement: z.string(),
    rationale: z.string(),
    evidence_ids: z.array(z.string()),
  }),
  handler: ({ ctx, run }, args) => {
    const cited = [...new Set(args.evidence_ids)];
    const historyEvidence = cited.length
      ? ctx.db
          .select()
          .from(evidence)
          .where(and(eq(evidence.workItemId, ONBOARDING_ID), eq(evidence.sourceType, "erp_history"), inArray(evidence.id, cited)))
          .all()
      : [];
    if (!historyEvidence.length) fail("Cite the AP history evidence returned by query_ap_history.", "EVIDENCE_REQUIRED");
    if (args.threshold_cents > 50_000) fail("A materiality threshold above $500 per line needs a controller-authored policy.", "POLICY");
    const rows = ctx.db.select().from(erpApHistory).all();
    const contradicts = rows.filter((r) => r.resolution === "DISPUTED_CREDITED" && r.varianceCents <= args.threshold_cents);
    if (contradicts.length) {
      fail(
        "The threshold would have accepted " + contradicts.length + " variance(s) the vendor later credited (" +
          contradicts.map((r) => r.lineRef + " " + formatCents(r.varianceCents)).join(", ") + "). Choose a lower threshold.",
        "HISTORY_CONFLICT",
      );
    }
    const existing = ctx.db
      .select()
      .from(policies)
      .where(and(eq(policies.policyKey, MATERIALITY_POLICY_KEY), inArray(policies.status, ["PROPOSED", "APPROVED"])))
      .get();
    if (existing) fail("Policy " + existing.id + " is already " + existing.status.toLowerCase() + ".", "POLICY_EXISTS");
    const statement = args.statement.trim().slice(0, 800);
    if (statement.length < 20) fail("Policy statement is too short.");
    const paidCovered = rows.filter((r) => r.resolution === "PAID_AS_BILLED" && r.varianceCents > 0 && r.varianceCents <= args.threshold_cents).length;
    const paidAbove = rows.filter((r) => r.resolution === "PAID_AS_BILLED" && r.varianceCents > args.threshold_cents).length;
    const versions = ctx.db.select().from(policies).where(eq(policies.policyKey, MATERIALITY_POLICY_KEY)).all();
    const version = Math.max(0, ...versions.map((p) => p.version)) + 1;
    const id = "POL-" + MATERIALITY_POLICY_KEY + "-v" + version;
    ctx.db
      .insert(policies)
      .values({
        id,
        policyKey: MATERIALITY_POLICY_KEY,
        version,
        title: "Billing variance materiality",
        status: "PROPOSED",
        statement,
        rule: {
          method: "accept_below_threshold",
          thresholdCents: args.threshold_cents,
          autoPostLimitCents: 1_000_000,
          appliesTo: "Instance invoice lines that exceed the contract-supported charge",
          conditions: [
            "Variance above $0 and at or below " + formatCents(args.threshold_cents) + " per line",
            "A single owning project is established",
            "Invoice line at or below $10,000",
            "Larger variances are disputed with the vendor",
          ],
        },
        rationale: args.rationale.trim().slice(0, 1200),
        evidenceIds: cited,
        precedentIds: [],
        learnedFromWorkItemId: null,
        proposedBy: run.agentId,
        supersedesId: null,
        createdAt: nowIso(),
      })
      .run();
    const approvalId = createApprovalRequest(ctx, {
      workItemId: ONBOARDING_ID,
      subjectType: "POLICY",
      subjectId: id,
      requestedBy: run.agentId,
      summary:
        "Adopt " + MATERIALITY_POLICY_KEY + " v" + version + ": accept variances up to " + formatCents(args.threshold_cents) +
        " per line. Matches " + paidCovered + " historical lines paid as billed; no credited dispute falls under it.",
    });
    return {
      result: {
        policy_id: id,
        approval_id: approvalId,
        history_check: { paid_lines_covered: paidCovered, paid_lines_above_threshold: paidAbove, credited_disputes_below_threshold: 0 },
      },
      title: "Finance Agent proposed " + MATERIALITY_POLICY_KEY + " v" + version + " from AP history",
      summary: statement,
      activityType: "POLICY",
      changes: ["Policy " + id + " proposed", "Approval " + approvalId + " pending"],
      terminal: { summary: "proposed " + id + " for controller approval" },
    };
  },
});

const finishOnboarding = defineTool({
  name: "finish_onboarding",
  agent: "finance",
  scope: "onboarding",
  permission: "history:read",
  category: "read",
  terminal: true,
  description: "End onboarding without proposing a policy, with a short note on what you found. Ends your run.",
  schema: z.object({ summary: z.string() }),
  handler: (_tc, args) => ({
    result: { done: true },
    title: "Finance Agent finished onboarding",
    summary: args.summary.slice(0, 600),
    terminal: { summary: "finished onboarding" },
  }),
});

export const TOOLS: ToolDefinition[] = [
  getWorkItemTool,
  getInstanceLifecycle,
  getGpuJobLogs,
  getExperiment,
  getProviderUsage,
  getBillingTerms,
  findRelatedExperiments,
  submitComputeFindings,
  handoffToFinance,
  requestHumanInfo,
  getProjectBudget,
  getAllocationPolicy,
  searchPrecedents,
  calculateCostAllocation,
  proposeAdjustment,
  proposeVendorDispute,
  proposePolicy,
  requestHumanApproval,
  submitForPosting,
  requestMoreInfo,
  getDisputeStatus,
  sendVendorFollowUp,
  escalateDispute,
  queryApHistory,
  proposeMaterialityPolicy,
  finishOnboarding,
];

export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

export function runScope(run: Pick<AgentRunContext, "workItemId">): "work_item" | "onboarding" {
  return run.workItemId === ONBOARDING_ID ? "onboarding" : "work_item";
}

export function toolsForAgent(agentId: string, scope: "work_item" | "onboarding" = "work_item") {
  const role = agentId === ACTOR.compute ? "compute" : agentId === ACTOR.finance ? "finance" : null;
  return TOOLS.filter((t) => (t.scope ?? "work_item") === scope && (t.agent === "shared" || t.agent === role));
}
