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
import { approvedDispute, closeDispute, submitApprovedDispute } from "../workflow/decisions";
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

/** Which employee a tool belongs to. Shared tools are available to every agent. */
export type AgentKey = "compute" | "finance" | "capacity" | "vendor" | "budget" | "policy";

export const AGENT_KEY: Record<string, AgentKey> = {
  [ACTOR.compute]: "compute",
  [ACTOR.finance]: "finance",
  [ACTOR.capacity]: "capacity",
  [ACTOR.vendorLiaison]: "vendor",
  [ACTOR.budget]: "budget",
  [ACTOR.policy]: "policy",
};

export interface ToolDefinition {
  name: string;
  agent: AgentKey | AgentKey[] | "shared";
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
/* Compute Investigator                                                       */
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
  agent: ["compute", "capacity"],
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
  agent: ["compute", "capacity", "vendor"],
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
  agent: "capacity",
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
  agent: ["compute", "capacity"],
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
      title: (getActor(ctx, run.agentId)?.name ?? "Agent") + " recorded findings: " + ASSESSMENT_LABEL[args.charge_assessment],
      summary,
      activityType: "FINDING",
      changes,
    };
  },
});

const handoffToFinance = defineTool({
  name: "handoff_to_finance",
  agent: ["compute", "capacity", "policy"],
  permission: "handoff:finance",
  category: "write",
  terminal: true,
  description: "Hand the work item to the Cost Accountant after your findings are recorded. Ends your run.",
  schema: z.object({ work_item_id: workItemId, note: z.string() }),
  handler: ({ ctx, run, item }, args) => {
    if (!latestComputeFinding(ctx, item)) fail("Submit compute findings before handing off.", "WORKFLOW");
    assignAgent(ctx, item.id, ACTOR.finance);
    enqueueJob(ctx, { workItemId: item.id, kind: "AGENT_RUN", agentId: ACTOR.finance, payload: { trigger: "handoff", note: args.note } });
    return {
      result: { handed_off_to: "Cost Accountant" },
      title: (getActor(ctx, run.agentId)?.name ?? "Agent") + " handed off to Cost Accountant",
      summary: args.note.slice(0, 500),
      activityType: "HANDOFF",
      changes: ["Assigned to Cost Accountant"],
      terminal: { summary: "handed off to Cost Accountant" },
    };
  },
});

const requestHumanInfo = defineTool({
  name: "request_human_info",
  agent: ["compute", "capacity"],
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
/* Cost Accountant                                                       */
/* ------------------------------------------------------------------ */

const getProjectBudget = defineTool({
  name: "get_project_budget",
  agent: ["finance", "budget"],
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
  agent: ["finance", "policy"],
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
      },
      evidence: policy
        ? [{ sourceType: "policy", sourceId: policy.id, label: "Policy " + policy.policyKey + " v" + policy.version, snapshot: policy }]
        : [],
      title: "Retrieved policy " + (policy ? policy.policyKey + " v" + policy.version : "(none)"),
      summary: policy?.statement ?? "No standing policy for explained variances.",
    };
  },
});

const searchPrecedents = defineTool({
  name: "search_precedents",
  agent: ["finance", "policy"],
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
      title: "Cost Accountant proposed allocation " + id + " v" + version,
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
      title: "Cost Accountant proposed a vendor dispute of " + formatCents(disputed),
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
  agent: "policy",
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
      title: "Cost Accountant proposed reusable policy " + POLICY_KEYS.sharedReservation + " v" + version,
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
      title: "Cost Accountant submitted " + proposal.id + " v" + proposal.version + " for controller approval",
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
    const outcome = item.type === "SHARED_ALLOCATION" ? "ALLOCATED_UNDER_POLICY" : "CHARGE_EXPLAINED";
    resolveReconciliation(ctx, item.invoiceLineId, outcome);
    setWorkItemOutcome(ctx, item.id, outcome);
    transitionWorkItem(ctx, item.id, "RESOLVED", ACTOR.orchestrator, "Reconciliation complete under " + standing.policyId);
    return {
      result: { posted: true, journal_entry_id: entryId, authorization },
      title: "Cost Accountant submitted " + proposal.id + " for posting under " + standing.policyId,
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
  description: "Send the work item back to the investigator who gathered the evidence (Compute Investigator, or Capacity Planner for reservations) with a specific question. Ends your run.",
  schema: z.object({ work_item_id: workItemId, question: z.string() }),
  handler: ({ ctx, run, item }, args) => {
    const target = item.type === "SHARED_ALLOCATION" ? ACTOR.capacity : ACTOR.compute;
    const name = getActor(ctx, target)?.name ?? target;
    if (item.state === "PROPOSED") transitionWorkItem(ctx, item.id, "INVESTIGATING", run.agentId, "More compute evidence requested");
    supersedeDrafts(ctx, item);
    assignAgent(ctx, item.id, target);
    enqueueJob(ctx, { workItemId: item.id, kind: "AGENT_RUN", agentId: target, payload: { trigger: "finance_question", question: args.question } });
    return {
      result: { handed_off_to: name },
      title: "Cost Accountant asked the " + name + " for more evidence",
      summary: args.question.slice(0, 500),
      activityType: "HANDOFF",
      changes: ["Assigned to " + name],
      terminal: { summary: "asked " + name + " for more evidence" },
    };
  },
});

/* ------------------------------------------------------------------ */
/* Vendor Liaison                                                      */
/* ------------------------------------------------------------------ */

const getDisputePackage = defineTool({
  name: "get_dispute_package",
  agent: "vendor",
  permission: "dispute:read",
  category: "read",
  description:
    "Read the controller-approved dispute for your work item: amounts, the Cost Accountant's reasoning, cited contract clauses, the provider, and any vendor reply so far.",
  schema: z.object({ work_item_id: workItemId }),
  handler: ({ ctx, item }) => {
    const found = approvedDispute(ctx, item);
    if (!found) fail("There is no controller-approved dispute on " + item.id + ".", "APPROVAL_REQUIRED");
    const { proposal, approval } = found;
    const d = proposal.payload.dispute!;
    const provider = ctx.db.select().from(providers).where(eq(providers.id, d.providerId)).get();
    const contract = contractForProvider(ctx, d.providerId);
    const clauses = contract.clauses.filter((c) => d.clauseRefs.includes(c.ref));
    const record = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, item.id)).get() ?? null;
    const approver = getActor(ctx, approval.decidedBy ?? "")?.name ?? approval.decidedBy;
    return {
      result: {
        proposal_id: proposal.id,
        approval_id: approval.id,
        approved_by: approver,
        provider: { id: d.providerId, name: provider?.name },
        invoice_line: d.invoiceLineId,
        invoiced: formatCents(d.invoicedCents),
        disputed_amount: formatCents(d.disputedCents),
        undisputed_amount: formatCents(d.undisputedCents),
        reason: d.reason,
        clauses: clauses.map((c) => ({ ref: c.ref, title: c.title, text: c.text })),
        vendor_dispute: record
          ? { id: record.id, status: record.status, vendor_reference: record.vendorReference, submitted_at: record.submittedAt, replied_at: record.resolvedAt }
          : null,
      },
      evidence: [{ sourceType: "dispute", sourceId: proposal.id, label: "Approved dispute " + proposal.id, snapshot: { dispute: d, approvalId: approval.id } }],
      title: record ? "Read " + (provider?.name ?? "vendor") + "'s reply on " + record.id : "Read approved dispute " + proposal.id,
      summary: record
        ? "Dispute " + record.id + " is " + record.status.toLowerCase().replace("_", " ") + "."
        : "Approved by " + approver + ": dispute " + formatCents(d.disputedCents) + " with " + (provider?.name ?? "the vendor") + ".",
    };
  },
});

const sendVendorDispute = defineTool({
  name: "send_vendor_dispute",
  agent: "vendor",
  permission: "dispute:send",
  category: "write",
  terminal: true,
  description:
    "Send the approved dispute to the provider with the letter you wrote. The ledger gateway submits it and checks the controller approval. The letter must state the approved disputed amount. Ends your run.",
  schema: z.object({ work_item_id: workItemId, subject: z.string(), message: z.string().describe("The letter to the provider's billing team.") }),
  handler: ({ ctx, item }, args) => {
    const found = approvedDispute(ctx, item);
    if (!found) fail("There is no controller-approved dispute on " + item.id + ".", "APPROVAL_REQUIRED");
    const amount = formatCents(found.proposal.payload.dispute!.disputedCents);
    const message = args.message.trim().slice(0, 3000);
    if (message.length < 80) fail("The letter is too short to send.");
    if (!message.includes(amount)) fail("The letter must state the approved disputed amount, " + amount + ".", "ARITHMETIC_CHECK");
    const sent = submitApprovedDispute(ctx, item, message);
    return {
      result: { dispute_id: sent.disputeId, vendor_reference: sent.vendorReference, provider: sent.provider, disputed_amount: amount },
      title: "Vendor Liaison sent " + sent.provider + " a dispute for " + amount,
      summary: args.subject.trim().slice(0, 200),
      activityType: "DISPUTE",
      changes: ["Dispute " + sent.disputeId + " SUBMITTED"],
      terminal: { summary: "sent dispute " + sent.disputeId + " to " + sent.provider },
    };
  },
});

const closeVendorDispute = defineTool({
  name: "close_dispute",
  agent: "vendor",
  permission: "dispute:close",
  category: "posting",
  terminal: true,
  description:
    "After the provider replies, book the outcome through the ledger gateway and close the work item: a credit reduces the payable; a denial charges the disputed amount to the owning project. Ends your run.",
  schema: z.object({ work_item_id: workItemId, summary: z.string().describe("One or two sentences on what the vendor decided.") }),
  handler: ({ ctx, item }, args) => {
    const closed = closeDispute(ctx, item);
    const credited = closed.outcome === "VENDOR_CREDIT";
    return {
      result: { outcome: closed.outcome, journal_entry_id: closed.entryId, dispute_id: closed.dispute.id, amount: formatCents(closed.dispute.amountCents) },
      title: credited
        ? "Vendor Liaison booked a " + formatCents(closed.dispute.amountCents) + " credit and closed " + item.id
        : "Vendor Liaison booked the upheld charge and closed " + item.id,
      summary: args.summary.trim().slice(0, 500),
      activityType: "COMPLETED",
      changes: ["Journal entry " + closed.entryId + " posted", "State: RESOLVED"],
      terminal: { summary: credited ? "booked vendor credit" : "booked upheld charge" },
    };
  },
});

/* ------------------------------------------------------------------ */
/* Budget Analyst                                                      */
/* ------------------------------------------------------------------ */

type BurnStatus = "on_track" | "watch" | "at_risk" | "over";

/** Month-to-date compute expense for a project and a straight-line projection to month end. */
function projectBurn(ctx: AppContext, projectId: string, period: string) {
  const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) fail("Unknown project " + projectId, "NOT_FOUND");
  const row = ctx.sqlite
    .prepare(
      "SELECT COALESCE(SUM(l.debit_cents - l.credit_cents), 0) AS total FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE l.account_code = '6100' AND l.project_id = ? AND e.period = ?",
    )
    .get(project.id, period) as { total: number };
  const [y, m] = period.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const now = new Date();
  const nowKey = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const periodKey = y * 12 + (m - 1);
  const elapsed = nowKey > periodKey ? daysInMonth : nowKey < periodKey ? 1 : Math.max(1, now.getUTCDate());
  const perDay = row.total / elapsed;
  const projected = Math.round(perDay * daysInMonth);
  const budget = project.monthlyBudgetCents;
  const remaining = budget - row.total;
  const status: BurnStatus = row.total > budget ? "over" : projected > budget ? "at_risk" : projected > budget * 0.9 ? "watch" : "on_track";
  const daysLeft = perDay > 0 ? Math.max(0, Math.floor(remaining / perDay)) : null;
  return { project, posted: row.total, budget, remaining, projected, daysInMonth, elapsed, status, daysLeft };
}

const getPostedCharges = defineTool({
  name: "get_posted_charges",
  agent: "budget",
  permission: "budget:read",
  category: "read",
  description: "List the journal entries posted for your work item and how much each research project was charged.",
  schema: z.object({ work_item_id: workItemId }),
  handler: ({ ctx, item }) => {
    const rows = ctx.sqlite
      .prepare(
        "SELECT e.id AS entry_id, e.memo AS memo, l.project_id AS project_id, SUM(l.debit_cents - l.credit_cents) AS cents FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.work_item_id = ? AND e.source = 'experiment_ledger' AND l.account_code = '6100' AND l.project_id IS NOT NULL GROUP BY e.id, l.project_id ORDER BY e.posted_at",
      )
      .all(item.id) as { entry_id: string; memo: string; project_id: string; cents: number }[];
    return {
      result: {
        charges: rows.map((r) => ({ entry_id: r.entry_id, memo: r.memo, project_id: r.project_id, project_name: projectName(ctx, r.project_id), amount: formatCents(r.cents) })),
        project_ids: [...new Set(rows.map((r) => r.project_id))],
      },
      title: "Read " + rows.length + " posted charge" + (rows.length === 1 ? "" : "s") + " on " + item.id,
      summary: rows.map((r) => projectName(ctx, r.project_id) + " " + formatCents(r.cents)).join(", ") || "Nothing charged to a project yet.",
    };
  },
});

const forecastProjectBurn = defineTool({
  name: "forecast_project_burn",
  agent: "budget",
  permission: "budget:read",
  category: "read",
  description:
    "Month-to-date compute spend for a research project, a straight-line projection to month end, days of budget left at this rate, and the computed status (on_track, watch, at_risk, over).",
  schema: z.object({ project_id: z.string() }),
  handler: ({ ctx, item }, args) => {
    const b = projectBurn(ctx, args.project_id, item.period);
    return {
      result: {
        project: { id: b.project.id, name: b.project.name, lead: b.project.lead },
        period: item.period,
        monthly_budget: formatCents(b.budget),
        posted_to_date: formatCents(b.posted),
        days_elapsed: b.elapsed,
        days_in_month: b.daysInMonth,
        projected_month_end: formatCents(b.projected),
        projected_pct_of_budget: Math.round((b.projected / b.budget) * 1000) / 10,
        days_of_budget_left: b.daysLeft,
        status: b.status,
      },
      evidence: [
        {
          sourceType: "budget",
          sourceId: b.project.id + ":" + item.period + ":forecast",
          label: b.project.name + " burn forecast " + item.period,
          snapshot: { postedCents: b.posted, budgetCents: b.budget, projectedCents: b.projected, elapsed: b.elapsed, daysInMonth: b.daysInMonth },
        },
      ],
      title: "Forecast " + b.project.name + " burn for " + item.period,
      summary:
        formatCents(b.posted) + " posted after " + b.elapsed + " of " + b.daysInMonth + " days; on pace for " + formatCents(b.projected) +
        " against " + formatCents(b.budget) + " (" + b.status.replace("_", " ") + ").",
    };
  },
});

const recordBudgetNote = defineTool({
  name: "record_budget_note",
  agent: "budget",
  permission: "budget:note",
  category: "write",
  terminal: true,
  description: "Record your burn assessment for a project on the work item. The status must match the computed forecast. Ends your run.",
  schema: z.object({
    work_item_id: workItemId,
    project_id: z.string(),
    status: z.enum(["on_track", "watch", "at_risk", "over"]),
    summary: z.string().describe("One or two sentences for the project lead and the controller."),
    evidence_ids: z.array(z.string()),
  }),
  handler: ({ ctx, run, item }, args) => {
    const b = projectBurn(ctx, args.project_id, item.period);
    if (args.status !== b.status) fail("The forecast puts " + b.project.name + " at " + b.status + ", not " + args.status + ".", "ARITHMETIC_CHECK");
    const summary = args.summary.trim().slice(0, 600);
    if (summary.length < 10) fail("Summary is too short.");
    const cited = requireEvidence(ctx, item, args.evidence_ids, 1);
    const id = nextId(ctx, "F", 5001);
    ctx.db
      .insert(findings)
      .values({
        id,
        workItemId: item.id,
        agentId: run.agentId,
        runId: run.runId,
        kind: "budget",
        summary,
        assessment: args.status,
        data: { project_id: b.project.id, posted_cents: b.posted, budget_cents: b.budget, projected_cents: b.projected, days_left: b.daysLeft },
        evidenceIds: cited,
        createdAt: nowIso(),
      })
      .run();
    return {
      result: { finding_id: id, status: b.status, projected_month_end: formatCents(b.projected) },
      title: "Budget Analyst: " + b.project.name + " is " + b.status.replace("_", " "),
      summary,
      activityType: "FINDING",
      changes: ["Finding " + id + " recorded"],
      terminal: { summary: b.project.name + " " + b.status.replace("_", " ") },
    };
  },
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
  getDisputePackage,
  sendVendorDispute,
  closeVendorDispute,
  getPostedCharges,
  forecastProjectBurn,
  recordBudgetNote,
];

export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

export function toolsForAgent(agentId: string) {
  const key = AGENT_KEY[agentId];
  if (!key) return [];
  return TOOLS.filter((t) => t.agent === "shared" || t.agent === key || (Array.isArray(t.agent) && t.agent.includes(key)));
}
