/**
 * Turns a work item's recorded activity into "frames": one small, replayable
 * card per unit of work (a query an agent ran, the rules intake checked, a
 * message an agent drafted, a journal entry the gateway posted).
 * Everything shown comes from stored tool arguments and results.
 */
import { agentSteps } from "./agent-steps";
import { dateTimeUtc, clockTime, money } from "./format";
import { sourceForTool, WRITE_TOOLS, type SourceId } from "./sources";
import type { ActivityRow, WorkspaceData } from "@/server/queries";

/** Ring seats are employees (AI agents). Code they rely on (intake rules, ledger gateway, policy memory) shows up inside their work. */
export type OrbitNodeId = "compute" | "finance" | "vendor" | "budget" | "policy" | "capacity";

export type Check = { label: string; detail?: string; ok?: boolean };

export type FrameSpec = {
  eyebrow: string;
  title: string;
  /** The system of record this frame read from or wrote to. */
  source?: { id: SourceId; name: string; logo: string; write?: boolean };
  query?: { lang: "sql" | "json" | "call"; text: string };
  table?: { cols: string[]; rows: string[][] };
  bars?: { label: string; share: number; display: string }[];
  checks?: Check[];
  draft?: { to: string; subject: string; body: string };
  ledger?: { lines: { account: string; memo: string; dr: string; cr: string }[]; balanced: boolean };
  summary?: string;
  evidence?: string[];
};

export type Frame = {
  id: string;
  node: OrbitNodeId;
  label: string;
  createdAt: string;
  tone: "ok" | "warn" | "denied" | "live";
  spec: FrameSpec;
};

/* ------------------------------------------------------------- json access */

function get(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
const s = (o: unknown, path: string) => {
  const v = get(o, path);
  return v === null || v === undefined ? "" : String(v);
};
const n = (o: unknown, path: string) => Number(get(o, path) ?? 0);
const list = (o: unknown, path: string) => {
  const v = get(o, path);
  return Array.isArray(v) ? v : [];
};
const q = (v: string) => "'" + v + "'";

/* ------------------------------------------------------------- labels */

const LABELS: Record<string, string> = {
  get_work_item: "Work item",
  get_instance_lifecycle: "Lifecycle",
  get_gpu_job_logs: "Job logs",
  get_experiment: "Experiment",
  get_provider_usage: "Meter",
  get_billing_terms: "Contract",
  find_related_experiments: "Usage",
  submit_compute_findings: "Findings",
  handoff_to_finance: "Handoff",
  request_human_info: "Question",
  get_project_budget: "Budget",
  get_allocation_policy: "Policy",
  search_precedents: "Precedents",
  calculate_cost_allocation: "Calculation",
  propose_adjustment: "Proposal",
  propose_vendor_dispute: "Dispute",
  propose_policy: "New policy",
  request_human_approval: "Approval",
  submit_for_posting: "Posting",
  request_more_info: "Question",
  get_dispute_package: "Dispute file",
  send_vendor_dispute: "Letter sent",
  close_dispute: "Case closed",
  get_posted_charges: "Postings",
  forecast_project_burn: "Forecast",
  record_budget_note: "Budget note",
};

const AGENT_NAME: Record<string, string> = {
  "agent.compute": "Compute Investigator",
  "agent.finance": "Cost Accountant",
  "agent.capacity": "Capacity Planner",
  "agent.vendor": "Vendor Liaison",
  "agent.budget": "Budget Analyst",
  "agent.policy": "Policy Analyst",
};

/** Which ring seat an employee's actor id maps to. */
export const NODE_OF: Record<string, OrbitNodeId> = {
  "agent.compute": "compute",
  "agent.finance": "finance",
  "agent.capacity": "capacity",
  "agent.vendor": "vendor",
  "agent.budget": "budget",
  "agent.policy": "policy",
};

/* ------------------------------------------------------------- tool frames */

function toolSpec(row: ActivityRow, w: WorkspaceData): FrameSpec {
  const a = row.args;
  const r = row.result;
  const who = AGENT_NAME[row.actorId] ?? row.actorId;
  const base: FrameSpec = {
    eyebrow: who + " · " + (row.toolName ?? "action"),
    title: row.title,
    summary: row.summary ?? undefined,
    evidence: row.evidenceIds.map((id) => w.evidence.find((e) => e.id === id)?.label ?? id),
  };
  const projectName = (id: string) => w.projects[id]?.name ?? id;

  switch (row.toolName) {
    case "get_work_item": {
      const flags = list(r, "deterministic_checks.flags");
      return {
        ...base,
        query: {
          lang: "sql",
          text:
            "SELECT w.*, l.description, l.quantity, l.unit_price\nFROM work_items w\nJOIN invoice_lines l ON l.id = w.invoice_line_id\nWHERE w.id = " +
            q(s(a, "work_item_id")) + ";",
        },
        table: {
          cols: ["Field", "Value"],
          rows: [
            ["Line", s(r, "invoice_line.description")],
            ["Invoiced", s(r, "amounts.invoiced")],
            ["Contract supports", s(r, "amounts.contract_supported")],
            ["Discrepancy", s(r, "amounts.discrepancy")],
          ],
        },
        checks: flags.length
          ? flags.map((f) => ({ label: s(f, "code"), detail: s(f, "message"), ok: false }))
          : [{ label: "Reconciliation checks", detail: "No flags", ok: true }],
      };
    }
    case "get_instance_lifecycle":
      return {
        ...base,
        query: {
          lang: "sql",
          text: "SELECT event_type, occurred_at, source\nFROM lifecycle_events\nWHERE instance_id = " + q(s(a, "instance_id")) + "\nORDER BY occurred_at;",
        },
        table: {
          cols: ["Event", "At", "Source"],
          rows: list(r, "events").map((e) => [s(e, "type"), dateTimeUtc(s(e, "at")), s(e, "source")]),
        },
        checks: [
          { label: "Instance lifetime", detail: n(r, "lifecycle_hours") + " h", ok: true },
          { label: "Termination confirmed", detail: s(r, "terminated_at") ? dateTimeUtc(s(r, "terminated_at")) : "No TERMINATED event", ok: Boolean(s(r, "terminated_at")) },
          { label: "Scheduler jobs on instance", detail: String(list(r, "jobs").length), ok: list(r, "jobs").length > 0 },
        ],
      };
    case "get_gpu_job_logs":
      return {
        ...base,
        query: { lang: "sql", text: "SELECT started_at, ended_at, gpus, logs\nFROM compute_jobs\nWHERE id = " + q(s(a, "job_id")) + ";" },
        table: { cols: ["Time", "Log"], rows: list(r, "job.logs").map((l) => [clockTime(s(l, "ts")), s(l, "message")]) },
        checks: [
          { label: "Wall clock", detail: n(r, "wall_clock_hours") + " h on " + n(r, "job.gpus") + " GPUs", ok: true },
          { label: "Job status", detail: s(r, "job.status"), ok: s(r, "job.status") === "COMPLETED" },
        ],
      };
    case "get_experiment":
      return {
        ...base,
        query: {
          lang: "sql",
          text: "SELECT e.name, e.owner, p.name AS project, p.cost_center\nFROM experiments e\nJOIN projects p ON p.id = e.project_id\nWHERE e.id = " + q(s(a, "experiment_id")) + ";",
        },
        table: {
          cols: ["Field", "Value"],
          rows: [
            ["Experiment", s(r, "experiment.name")],
            ["Owner", s(r, "experiment.owner")],
            ["Project", s(r, "project.name")],
            ["Cost center", s(r, "project.costCenter")],
          ],
        },
        checks: [{ label: "Owner identified", detail: s(r, "project.name"), ok: Boolean(s(r, "project.name")) }],
      };
    case "get_provider_usage":
      return {
        ...base,
        query: { lang: "sql", text: "SELECT usage_start, usage_end, hours\nFROM provider_usage\nWHERE instance_id = " + q(s(a, "instance_id")) + ";" },
        table: {
          cols: ["Start", "End", "Hours"],
          rows: list(r, "meter_records").map((m) => [dateTimeUtc(s(m, "usageStart")), dateTimeUtc(s(m, "usageEnd")), s(m, "hours")]),
        },
        checks: [{ label: "Provider metered", detail: n(r, "total_hours") + " h", ok: true }],
      };
    case "get_billing_terms": {
      const billed = n(r, "computed.billed_hours");
      const billable = n(r, "computed.contract_billable_hours");
      const unsupported = s(r, "computed.amount_not_supported_by_contract");
      return {
        ...base,
        query: { lang: "sql", text: "SELECT ref, title, text\nFROM contracts, json_each(contracts.clauses)\nWHERE provider_id = " + q(s(a, "provider_id")) + ";" },
        table: { cols: ["Clause", "Title"], rows: list(r, "clauses").map((c) => [s(c, "ref"), s(c, "title")]) },
        checks: [
          { label: "Billed hours within contract", detail: billed + " h billed vs " + billable + " h billable", ok: billed <= billable },
          {
            label: "Rate matches contract",
            detail: s(r, "computed.invoiced_rate_per_hour") + " vs " + s(r, "computed.contract_rate_per_hour"),
            ok: s(r, "computed.invoiced_rate_per_hour") === s(r, "computed.contract_rate_per_hour"),
          },
          { label: "Charge supported by contract", detail: unsupported ? unsupported + " not supported" : "", ok: unsupported === "$0.00" || unsupported === "" },
        ],
      };
    }
    case "find_related_experiments": {
      const reserved = n(r, "reserved_gpu_hours") || 1;
      const usage = list(r, "usage_by_project");
      return {
        ...base,
        query: {
          lang: "sql",
          text:
            "SELECT e.project_id, SUM(j.gpus * hours(j.started_at, j.ended_at)) AS gpu_hours\nFROM compute_jobs j\nJOIN experiments e ON e.id = j.experiment_id\nWHERE j.reservation_id = " +
            q(s(a, "reservation_id")) + "\nGROUP BY e.project_id;",
        },
        bars: [
          ...usage.map((u) => ({ label: s(u, "project_name"), share: n(u, "gpu_hours") / reserved, display: n(u, "gpu_hours") + " GPU-h" })),
          { label: "Idle", share: n(r, "idle_gpu_hours") / reserved, display: n(r, "idle_gpu_hours") + " GPU-h" },
        ],
        checks: [
          { label: "Reservation owner", detail: s(r, "reservation.owner_project_name"), ok: true },
          {
            label: "Owner accountable for idle",
            detail: get(r, "reservation.owner_accountable_for_idle") ? "Yes, per internal terms" : "Not stated",
            ok: Boolean(get(r, "reservation.owner_accountable_for_idle")),
          },
        ],
      };
    }
    case "submit_compute_findings": {
      const c = get(r, "computed");
      const assessment = s(a, "charge_assessment");
      if (s(c, "lifecycle_hours")) {
        return {
          ...base,
          checks: [
            { label: "Lifecycle hours", detail: n(c, "lifecycle_hours") + " h", ok: true },
            { label: "Contract billable", detail: n(c, "contract_billable_hours") + " h", ok: true },
            { label: "Billed", detail: n(c, "billed_hours") + " h", ok: n(c, "billed_hours") <= n(c, "contract_billable_hours") },
            { label: "Scheduler runtime", detail: n(c, "scheduler_hours") + " h (" + n(c, "idle_hours") + " h idle)" },
            { label: "Provider meter", detail: n(c, "provider_meter_hours") + " h", ok: n(c, "provider_meter_hours") === n(c, "lifecycle_hours") },
            { label: "Discrepancy", detail: money(n(c, "discrepancy_cents")), ok: n(c, "discrepancy_cents") === 0 },
            { label: "Assessment", detail: assessment.replace("_", " "), ok: assessment === "explained" ? true : assessment === "not_explained" ? false : undefined },
          ],
          summary: s(a, "summary"),
        };
      }
      return { ...base, checks: [{ label: "Assessment", detail: assessment.replace("_", " ") }], summary: s(a, "summary") };
    }
    case "handoff_to_finance":
      return { ...base, draft: { to: "Cost Accountant", subject: "Handoff: " + w.item.id, body: s(a, "note") }, summary: undefined };
    case "request_human_info":
      return { ...base, draft: { to: "Controller", subject: "Question on " + w.item.id, body: s(a, "question") }, summary: undefined };
    case "request_more_info":
      return { ...base, draft: { to: "Compute Investigator", subject: "More evidence for " + w.item.id, body: s(a, "question") }, summary: undefined };
    case "get_project_budget":
      return {
        ...base,
        query: {
          lang: "sql",
          text: "SELECT p.monthly_budget, SUM(l.debit_cents) AS posted\nFROM projects p\nJOIN journal_lines l ON l.project_id = p.id\nWHERE p.id = " + q(s(a, "project_id")) + ";",
        },
        bars: [{ label: s(r, "project.name"), share: n(r, "utilization_pct") / 100, display: s(r, "posted_to_date") + " of " + s(r, "monthly_budget") }],
        checks: [{ label: "Budget remaining", detail: s(r, "remaining"), ok: n(r, "utilization_pct") < 100 }],
      };
    case "get_allocation_policy":
      return {
        ...base,
        query: { lang: "sql", text: "SELECT id, statement, rule\nFROM policies\nWHERE status = 'APPROVED'\n  AND applies_to(" + q(s(a, "work_item_id")) + ");" },
        table: {
          cols: ["Policy", "Auto-post limit"],
          rows: [[s(r, "applicable_policy.id"), s(r, "applicable_policy.auto_post_limit")]],
        },
        checks: list(r, "conditions").map((c) => ({ label: String(c) })),
        summary: s(r, "applicable_policy.statement") || row.summary || undefined,
      };
    case "search_precedents":
      return {
        ...base,
        query: { lang: "sql", text: "SELECT id, title, decided_by\nFROM precedents\nWHERE text MATCH " + q(s(a, "query")) + "\nLIMIT 4;" },
        table: { cols: ["Id", "Decision", "By"], rows: list(r, "matches").map((m) => [s(m, "id"), s(m, "title"), s(m, "decided_by")]) },
        summary: undefined,
      };
    case "calculate_cost_allocation": {
      const lines = list(r, "lines");
      const total = lines.reduce((sum: number, l) => sum + Number(s(l, "amount").replace(/[$,]/g, "") || 0), 0) || 1;
      return {
        ...base,
        query: { lang: "call", text: "calculate_cost_allocation(\n  work_item = " + q(s(a, "work_item_id")) + ",\n  method = " + q(s(a, "method")) + "\n)" },
        bars: lines.map((l) => ({
          label: s(l, "project_name"),
          share: Number(s(l, "amount").replace(/[$,]/g, "") || 0) / total,
          display: s(l, "amount"),
        })),
        checks: [
          { label: "Method", detail: s(r, "method_label") },
          { label: "Lines sum exactly to total", detail: s(r, "total"), ok: Boolean(get(r, "sums_exactly_to_total")) },
        ],
      };
    }
    case "propose_adjustment": {
      const proposal = w.proposals.find((p) => p.id === s(r, "proposal_id"));
      const auth = get(r, "standing_authorization");
      return {
        ...base,
        table: proposal
          ? {
              cols: ["Project", "Amount"],
              rows: proposal.payload.allocation.map((l) => [projectName(l.projectId), money(l.amountCents)]),
            }
          : undefined,
        checks: [
          {
            label: "Standing policy covers it",
            detail: s(auth, "reason") || "Needs controller approval",
            ok: Boolean(get(auth, "authorized")),
          },
        ],
        summary: s(a, "rationale") || base.summary,
      };
    }
    case "propose_vendor_dispute": {
      const provider = w.providers[w.item.providerId]?.name ?? "Vendor";
      const body =
        "Hello " + provider + " billing team,\n\n" +
        "We are disputing " + s(r, "disputed_amount") + " on invoice line " + (w.line?.externalLineId ?? w.item.invoiceLineId) + ".\n\n" +
        s(a, "rationale") +
        "\n\nContract clauses: " + list(a, "clause_refs").join(", ") +
        "\nUndisputed amount: " + s(r, "undisputed_amount") +
        "\n\nPlease issue a credit for the disputed amount.\n\nAtlas Research Finance";
      return {
        ...base,
        draft: { to: provider + " billing", subject: "Billing dispute: " + (w.line?.externalLineId ?? w.item.invoiceLineId), body },
        summary: s(r, "liability_note") || undefined,
      };
    }
    case "propose_policy":
      return {
        ...base,
        draft: {
          to: "Controller",
          subject: "Proposed policy " + s(r, "policy_id"),
          body: s(a, "statement") + "\n\nWhy: " + s(a, "rationale"),
        },
        checks: list(a, "precedent_ids").map((id) => ({ label: "Cites " + String(id), ok: true })),
        summary: undefined,
      };
    case "request_human_approval":
      return {
        ...base,
        draft: { to: (w.actors["human.controller"]?.name ?? "Controller") + " (Controller)", subject: "Approval needed: " + s(a, "proposal_id"), body: s(a, "summary") },
        summary: undefined,
      };
    case "submit_for_posting":
      return {
        ...base,
        query: { lang: "call", text: "ledger_gateway.post(\n  proposal = " + q(s(a, "proposal_id")) + "\n)" },
        checks: [
          { label: "Standing policy verified", detail: s(r, "authorization"), ok: Boolean(get(r, "posted")) },
          { label: "Journal entry posted", detail: s(r, "journal_entry_id"), ok: Boolean(get(r, "posted")) },
        ],
      };
    case "get_dispute_package":
      return {
        ...base,
        query: { lang: "sql", text: "SELECT p.payload, a.decided_by, d.status\nFROM proposals p\nJOIN approval_requests a ON a.subject_id = p.id\nLEFT JOIN vendor_disputes d ON d.proposal_id = p.id\nWHERE p.id = " + q(s(r, "proposal_id")) + ";" },
        table: {
          cols: ["Field", "Value"],
          rows: [
            ["Provider", s(r, "provider.name")],
            ["Invoiced", s(r, "invoiced")],
            ["Disputed", s(r, "disputed_amount")],
            ["Approved by", s(r, "approved_by")],
            ...(get(r, "vendor_dispute") ? [["Vendor reply", s(r, "vendor_dispute.status").replace("_", " ").toLowerCase()]] : []),
          ],
        },
        checks: list(r, "clauses").map((c) => ({ label: "Clause " + s(c, "ref") + " · " + s(c, "title"), detail: s(c, "text") })),
      };
    case "send_vendor_dispute":
      return {
        ...base,
        draft: { to: s(r, "provider") + " billing", subject: s(a, "subject"), body: s(a, "message") },
        checks: [
          { label: "States the approved amount", detail: s(r, "disputed_amount"), ok: true },
          { label: "Submitted by the ledger gateway", detail: s(r, "dispute_id") + " · " + s(r, "vendor_reference"), ok: true },
        ],
        summary: undefined,
      };
    case "close_dispute": {
      const credited = s(r, "outcome") === "VENDOR_CREDIT";
      return {
        ...base,
        checks: [
          { label: credited ? "Vendor issued a credit" : "Vendor denied the dispute", detail: s(r, "amount"), ok: credited },
          { label: credited ? "Payable reduced" : "Charged to the owning project", detail: s(r, "journal_entry_id"), ok: true },
          { label: "Case closed", detail: s(r, "dispute_id"), ok: true },
        ],
        summary: s(a, "summary") || base.summary,
      };
    }
    case "get_posted_charges":
      return {
        ...base,
        query: { lang: "sql", text: "SELECT e.id, l.project_id, SUM(l.debit_cents) AS charged\nFROM journal_entries e\nJOIN journal_lines l ON l.entry_id = e.id\nWHERE e.work_item_id = " + q(w.item.id) + "\nGROUP BY e.id, l.project_id;" },
        table: { cols: ["Entry", "Project", "Charged"], rows: list(r, "charges").map((c) => [s(c, "entry_id"), s(c, "project_name"), s(c, "amount")]) },
        summary: undefined,
      };
    case "forecast_project_burn": {
      const budget = Number(s(r, "monthly_budget").replace(/[$,]/g, "")) || 1;
      const money2 = (k: string) => Number(s(r, k).replace(/[$,]/g, "")) || 0;
      const status = s(r, "status");
      return {
        ...base,
        query: { lang: "call", text: "forecast_project_burn(\n  project = " + q(s(a, "project_id")) + ",\n  days = " + n(r, "days_elapsed") + " of " + n(r, "days_in_month") + "\n)" },
        bars: [
          { label: "Posted so far", share: money2("posted_to_date") / budget, display: s(r, "posted_to_date") },
          { label: "On pace for", share: money2("projected_month_end") / budget, display: s(r, "projected_month_end") + " (" + n(r, "projected_pct_of_budget") + "%)" },
        ],
        checks: [
          { label: "Monthly budget", detail: s(r, "monthly_budget") },
          { label: "Status", detail: status.replace("_", " "), ok: status === "on_track" ? true : status === "watch" ? undefined : false },
        ],
      };
    }
    case "record_budget_note": {
      const status = s(a, "status");
      return {
        ...base,
        checks: [{ label: "Status matches the forecast", detail: status.replace("_", " "), ok: true }],
        summary: s(a, "summary") || base.summary,
      };
    }
    default:
      return {
        ...base,
        query: { lang: "call", text: (row.toolName ?? "action") + "(" + JSON.stringify(a ?? {}, null, 2) + ")" },
      };
  }
}

/* ------------------------------------------------------------- intake */

function intakeFrames(w: WorkspaceData): Frame[] {
  const frames: Frame[] = [];
  const first: OrbitNodeId = w.item.type === "SHARED_ALLOCATION" ? "capacity" : "compute";
  const line = w.line;
  if (line) {
    frames.push({
      id: "intake-event",
      node: first,
      label: "Billing event",
      createdAt: w.item.createdAt,
      tone: "ok",
      spec: {
        eyebrow: "Provider feed · webhook",
        title: "Received " + line.externalLineId + " from " + (w.providers[w.item.providerId]?.name ?? w.item.providerId),
        query: {
          lang: "json",
          text: JSON.stringify(
            {
              invoice: w.invoice?.invoiceNumber ?? line.invoiceId,
              line: line.externalLineId,
              description: line.description,
              quantity: line.quantity,
              unit_price: money(line.unitPriceCents),
              amount: money(line.amountCents),
              service: dateTimeUtc(line.serviceStart) + " to " + dateTimeUtc(line.serviceEnd),
            },
            null,
            2,
          ),
        },
        checks: [{ label: "New event id", detail: "Not seen before; ingesting once", ok: true }],
      },
    });
  }

  const c = w.item.checks;
  const flagged = new Set(c.flags.map((f) => f.code));
  const flagMsg = (code: string) => c.flags.find((f) => f.code === code)?.message;
  let checks: Check[];
  let table: FrameSpec["table"];
  if (c.kind === "instance") {
    checks = [
      { label: "Rate matches contract", detail: flagMsg("RATE_MISMATCH") ?? money(c.invoicedRateCents) + "/h", ok: !flagged.has("RATE_MISMATCH") },
      {
        label: "Billed hours within lifecycle",
        detail: flagMsg("QUANTITY_EXCEEDS_LIFECYCLE") ?? c.billedHours + " h billed, " + c.billableHours + " h billable",
        ok: !flagged.has("QUANTITY_EXCEEDS_LIFECYCLE"),
      },
      { label: "Amount matches contract", detail: flagMsg("AMOUNT_VARIANCE") ?? money(c.invoicedCents), ok: !flagged.has("AMOUNT_VARIANCE") },
      { label: "Meter agrees with lifecycle", detail: flagMsg("METER_MISMATCH") ?? c.providerMeterHours + " h", ok: !flagged.has("METER_MISMATCH") },
      { label: "Termination recorded", detail: flagMsg("NO_TERMINATION_RECORD") ?? dateTimeUtc(c.terminatedAt), ok: !flagged.has("NO_TERMINATION_RECORD") },
      { label: "Scheduler covers runtime", detail: flagMsg("IDLE_TIME") ?? c.schedulerHours + " h of jobs", ok: !flagged.has("IDLE_TIME") },
      { label: "Owner identified", detail: flagMsg("MISSING_OWNER") ?? c.ownerProjectIds.map((p) => w.projects[p]?.name ?? p).join(", "), ok: !flagged.has("MISSING_OWNER") },
    ];
    table = {
      cols: ["Source", "Hours"],
      rows: [
        ["Invoice", String(c.billedHours)],
        ["Lifecycle", String(c.lifecycleHours)],
        ["Provider meter", String(c.providerMeterHours)],
        ["Scheduler jobs", String(c.schedulerHours)],
      ],
    };
  } else {
    checks = [
      ...c.flags.map((f) => ({ label: f.code, detail: f.message, ok: false })),
      { label: "Amount matches commitment", detail: money(c.invoicedCents), ok: !flagged.has("AMOUNT_VARIANCE") },
    ];
    table = {
      cols: ["Reservation", "GPU-h"],
      rows: [
        ["Reserved", String(c.reservedGpuHours)],
        ["Used", String(c.usedGpuHours)],
        ["Idle", String(c.idleGpuHours)],
        ...c.usageByProject.map((u) => [w.projects[u.projectId]?.name ?? u.projectId, String(u.gpuHours)]),
      ],
    };
  }
  const opened = w.activity.find((e) => e.type === "WORK_ITEM");
  frames.push({
    id: "intake-rules",
    node: first,
    label: "Rule checks",
    createdAt: opened?.createdAt ?? w.item.createdAt,
    tone: c.flags.length ? "warn" : "ok",
    spec: {
      eyebrow: "Deterministic checks · code, no model",
      title: c.flags.length ? c.flags.length + " rule" + (c.flags.length > 1 ? "s" : "") + " flagged; opened " + w.item.id : "All rules passed",
      query: {
        lang: "sql",
        text:
          c.kind === "instance"
            ? "SELECT l.quantity, l.unit_price, i.lifecycle_hours,\n       u.meter_hours, j.scheduler_hours\nFROM invoice_lines l\nJOIN gpu_instances i ON i.id = l.instance_id\nWHERE l.id = " + q(w.item.invoiceLineId) + ";"
            : "SELECT r.gpu_count * r.hours AS reserved, SUM(j.gpu_hours)\nFROM reservations r\nJOIN compute_jobs j ON j.reservation_id = r.id\nWHERE r.id = " + q(c.reservationId) + ";",
      },
      table,
      checks,
      summary: opened?.summary ?? undefined,
    },
  });
  return frames;
}

/* ------------------------------------------------------------- ledger, vendor, policy */

function ledgerFrames(w: WorkspaceData, denied: ActivityRow[]): Frame[] {
  const frames: Frame[] = w.journal.map((e) => {
    const debits = e.lines.reduce((sum, l) => sum + l.debitCents, 0);
    const credits = e.lines.reduce((sum, l) => sum + l.creditCents, 0);
    return {
      id: "je-" + e.id,
      node: (e.idempotencyKey.startsWith("dispute:") ? "vendor" : "finance") as OrbitNodeId,
      label: e.id,
      createdAt: e.postedAt,
      tone: "ok" as const,
      spec: {
        eyebrow: "Ledger gateway · " + (e.source === "erp_ap" ? "AP accrual" : "allocation"),
        title: "Posted " + e.id + " · " + money(e.totalCents),
        ledger: {
          lines: e.lines.map((l) => ({
            account: l.accountCode,
            memo: l.projectId ? (w.projects[l.projectId]?.name ?? l.projectId) : l.memo,
            dr: l.debitCents ? money(l.debitCents) : "",
            cr: l.creditCents ? money(l.creditCents) : "",
          })),
          balanced: debits === credits,
        },
        checks: [
          { label: "Debits equal credits", detail: money(debits) + " = " + money(credits), ok: debits === credits },
          { label: "Authorized", detail: e.authorization, ok: true },
          { label: "Idempotent", detail: e.idempotencyKey, ok: true },
        ],
        summary: e.memo,
      },
    };
  });
  for (const row of denied) {
    frames.push({
      id: "denied-" + row.id,
      node: "finance",
      label: "Denied",
      createdAt: row.createdAt,
      tone: "denied",
      spec: {
        eyebrow: "Ledger gateway · denied",
        title: row.title,
        checks: [{ label: "Gateway check", detail: row.summary ?? "", ok: false }],
        summary: "Nothing was posted. The agent has to ask the controller instead.",
      },
    });
  }
  return frames;
}

/** The vendor's reply, as it reached the Vendor Liaison. The letter itself is the Liaison's own frame. */
function vendorReplyFrames(w: WorkspaceData): Frame[] {
  if (!w.dispute || w.dispute.status === "SUBMITTED") return [];
  const provider = w.providers[w.item.providerId]?.name ?? "Vendor";
  const credited = w.dispute.status === "CREDIT_ACCEPTED";
  return [
    {
      id: "vendor-reply-" + w.dispute.id,
      node: "vendor",
      label: credited ? "Vendor reply" : "Denied",
      createdAt: w.dispute.resolvedAt ?? w.dispute.submittedAt,
      tone: credited ? "ok" : "denied",
      spec: {
        eyebrow: "Inbox · reply from " + provider,
        title: credited ? provider + " accepted and credited " + money(w.dispute.amountCents) : provider + " denied the dispute",
        checks: [
          { label: "Vendor reference", detail: w.dispute.vendorReference ?? "", ok: credited },
          { label: credited ? "Credit memo issued" : "Charge upheld", detail: money(w.dispute.amountCents), ok: credited },
        ],
      },
    },
  ];
}

function policyFrames(w: WorkspaceData): Frame[] {
  return w.policies.map((p) => {
    const approver = p.approvedBy ? (w.actors[p.approvedBy]?.name ?? p.approvedBy) : null;
    const statusCheck: Check =
      p.status === "APPROVED"
        ? { label: "Approved", detail: approver ? "by " + approver : "", ok: true }
        : p.status === "PROPOSED"
          ? { label: "Waiting for controller approval" }
          : p.status === "REJECTED"
            ? { label: "Rejected", ok: false }
            : { label: "Superseded", detail: "Replaced by a newer version" };
    return {
      id: "policy-" + p.id,
      node: "policy" as const,
      label: p.policyKey + " v" + p.version,
      createdAt: p.createdAt,
      tone: p.status === "PROPOSED" ? ("warn" as const) : p.status === "REJECTED" ? ("denied" as const) : ("ok" as const),
      spec: {
        eyebrow: "Policy · " + p.status.toLowerCase(),
        title: p.title + " v" + p.version,
        summary: p.statement,
        checks: [
          statusCheck,
          ...p.rule.conditions.map((c) => ({ label: c })),
          { label: "Auto-post limit", detail: money(p.rule.autoPostLimitCents) },
          ...(p.learnedFromWorkItemId ? [{ label: "Learned from " + p.learnedFromWorkItemId, detail: "From controller feedback", ok: true }] : []),
        ],
      },
    };
  });
}

/* ------------------------------------------------------------- live frame */

function liveFrame(w: WorkspaceData, agentId: string): Frame | null {
  const run = w.runs.filter((r) => r.agentId === agentId).at(-1);
  if (!run || run.status !== "running") return null;
  const tools = w.activity.filter((e) => e.runId === run.id && e.toolName).map((e) => e.toolName!);
  const { steps, current } = agentSteps(agentId, tools, "running");
  return {
    id: "live-" + run.id,
    node: NODE_OF[agentId],
    label: current?.verb ?? "Working",
    createdAt: "9999-12-31T23:59:59.999Z",
    tone: "live",
    spec: {
      eyebrow: AGENT_NAME[agentId] + " · " + (run.mode === "llm" ? "LLM run " : "replay ") + run.id,
      title: (current?.verb ?? "Working") + "...",
      checks: steps.map((st) => ({ label: st.label, ok: st.state === "done" ? true : undefined, detail: st.state === "active" ? "in progress" : st.state === "todo" ? "next" : "" })),
      summary: run.task,
    },
  };
}

/* ------------------------------------------------------------- entry */

export function buildFrames(w: WorkspaceData): Frame[] {
  const frames: Frame[] = [...intakeFrames(w)];
  const deniedPostings: ActivityRow[] = [];
  for (const row of w.activity) {
    const agent = NODE_OF[row.actorId] ?? null;
    if (!agent) continue;
    if (row.status === "denied" || row.status === "error") {
      if (row.title.includes("submit_for_posting")) {
        deniedPostings.push(row);
        continue;
      }
      frames.push({
        id: "act-" + row.id,
        node: agent,
        label: row.status === "denied" ? "Denied" : "Failed",
        createdAt: row.createdAt,
        tone: "denied",
        spec: { eyebrow: (AGENT_NAME[row.actorId] ?? row.actorId) + " · " + row.status, title: row.title, checks: [{ label: "Gateway check", detail: row.summary ?? "", ok: false }] },
      });
      continue;
    }
    if (!row.toolName) continue;
    const src = sourceForTool(row.toolName, w.item.providerId);
    const spec = toolSpec(row, w);
    frames.push({
      id: "act-" + row.id,
      node: agent,
      label: LABELS[row.toolName] ?? row.toolName,
      createdAt: row.createdAt,
      tone: "ok",
      spec: src ? { ...spec, source: { id: src.id, name: src.name, logo: src.logo, write: WRITE_TOOLS.has(row.toolName) } } : spec,
    });
  }
  frames.push(...ledgerFrames(w, deniedPostings), ...vendorReplyFrames(w), ...policyFrames(w));
  for (const id of Object.keys(NODE_OF)) {
    const live = liveFrame(w, id);
    if (live) frames.push(live);
  }
  return frames.sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0));
}

