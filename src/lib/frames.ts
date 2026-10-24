/**
 * Turns a work item's recorded activity into "frames": one small, replayable
 * card per unit of work (a query an agent ran, the rules intake checked, a
 * message an agent drafted, a journal entry the gateway posted).
 * Everything shown comes from stored tool arguments and results.
 */
import { agentSteps } from "./agent-steps";
import { dateTimeUtc, clockTime, compactMoney, dateOnly, hours, money } from "./format";
import { sourceForTool, WRITE_TOOLS, type SourceId } from "./sources";
import type { ActivityRow, WorkspaceData } from "@/server/queries";

/** Ring seats are employees (AI agents). Code they rely on (intake rules, ledger gateway, policy memory) shows up inside their work. */
export type OrbitNodeId = "compute" | "finance" | "vendor" | "budget" | "policy" | "capacity";

export type Check = { label: string; detail?: string; ok?: boolean };

/** Color of a bar, row or pill. Muted is idle or not counted. */
export type Tone = "base" | "ok" | "warn" | "bad" | "muted";

/** Time ranges on one shared axis. Positions are fractions of the axis, 0 to 1. */
export type TimelineSpec = {
  ticks: { at: number; label: string }[];
  lanes: { key: string; label: string; value: string; tone: Tone; spans: { from: number; to: number; tone?: Tone }[] }[];
  marks: { at: number; label: string; tone: Tone }[];
};

/** One amount checked against the records that should support it. */
export type MatchSpec = {
  head: { label: string; detail: string; value: string };
  rows: { label: string; detail?: string; value: string; delta?: string; tone: Tone }[];
  result: { label: string; value: string; tone: Tone };
};

/** One whole split into parts: a single stacked bar with a legend. */
export type StackSpec = { total: string; parts: { label: string; share: number; display: string; tone?: Tone }[] };

/** Month-to-date spend, its straight-line projection, and the budget. Amounts in cents. */
export type BurnSpec = { days: number; elapsed: number; budget: number; posted: number; projected: number; tone: Tone };

/** A case with an outside party: where it stands and the messages so far. */
export type ThreadSpec = {
  steps: { label: string; state: "done" | "now" | "todo"; tone?: Tone }[];
  messages: { from: string; to: string; subject?: string; body: string; tone?: Tone }[];
};

/** An invoice line as the vendor sent it. */
export type DocSpec = {
  vendor: string;
  logo?: string;
  number: string;
  meta: { label: string; value: string }[];
  line: { description: string; qty: string; rate: string; amount: string };
};

export type FrameSpec = {
  eyebrow: string;
  title: string;
  /** The system of record this frame read from or wrote to. */
  source?: { id: SourceId; name: string; logo: string; write?: boolean };
  status?: { label: string; tone: Tone };
  doc?: DocSpec;
  timeline?: TimelineSpec;
  match?: MatchSpec;
  stack?: StackSpec;
  burn?: BurnSpec;
  thread?: ThreadSpec;
  query?: { lang: "sql" | "json" | "call"; text: string };
  table?: { cols: string[]; rows: string[][] };
  bars?: { label: string; share: number; display: string }[];
  checks?: Check[];
  draft?: { to: string; subject: string; body: string };
  ledger?: { lines: { account: string; memo: string; dr: string; cr: string }[]; balanced: boolean };
  summary?: string;
  evidence?: string[];
  /** Records the employee read on the way to this frame. */
  sources?: string[];
};

export type Frame = {
  id: string;
  node: OrbitNodeId;
  label: string;
  createdAt: string;
  tone: "ok" | "warn" | "denied" | "live";
  spec: FrameSpec;
  /** Other activity ids folded into this frame (reads, follow-up calls). */
  members?: string[];
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
/** "$1,234.50" to 1234.5. */
const dollars = (v: string) => Number(v.replace(/[$,]/g, "")) || 0;

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
        stack: {
          total: n(r, "reserved_gpu_hours").toLocaleString("en-US") + " GPU-h reserved",
          parts: [
            ...usage.map((u) => ({ label: s(u, "project_name"), share: n(u, "gpu_hours") / reserved, display: n(u, "gpu_hours").toLocaleString("en-US") + " GPU-h" })),
            { label: "Idle", share: n(r, "idle_gpu_hours") / reserved, display: n(r, "idle_gpu_hours").toLocaleString("en-US") + " GPU-h", tone: "muted" as const },
          ],
        },
        checks: [
          {
            label: "Idle time goes to " + s(r, "reservation.owner_project_name"),
            detail: get(r, "reservation.owner_accountable_for_idle") ? "The reservation owner pays for idle, per internal terms" : "Internal terms do not say who pays for idle",
            ok: Boolean(get(r, "reservation.owner_accountable_for_idle")),
          },
        ],
      };
    }
    case "submit_compute_findings": {
      const c = get(r, "computed");
      const assessment = s(a, "charge_assessment");
      const status = { label: assessment.replace(/_/g, " "), tone: (assessment === "explained" ? "ok" : assessment === "not_explained" ? "bad" : "warn") as Tone };
      if (s(c, "lifecycle_hours")) {
        const billed = n(c, "billed_hours");
        const life = n(c, "lifecycle_hours");
        const meter = n(c, "provider_meter_hours");
        const billable = n(c, "contract_billable_hours");
        const idle = n(c, "idle_hours");
        const gap = n(c, "discrepancy_cents");
        const rate = w.item.checks.kind === "instance" ? w.item.checks.contractRateCents : 0;
        const delta = (h: number) => {
          const d = Math.round((h - billed) * 100) / 100;
          return d === 0 ? "same as billed" : (d > 0 ? "+" : "") + d.toLocaleString("en-US") + " h";
        };
        return {
          ...base,
          title: gap > 0 ? money(gap) + " of " + money(w.line?.amountCents) + " is not supported" : "Charge supported in full",
          status,
          match: {
            head: {
              label: "Invoice " + (w.line?.externalLineId ?? w.item.invoiceLineId),
              detail: hours(billed) + " at " + money(w.line?.unitPriceCents) + "/h",
              value: money(w.line?.amountCents),
            },
            rows: [
              { label: "Provider meter", detail: "What the provider says it metered", value: hours(meter), delta: delta(meter), tone: Math.abs(meter - life) <= 0.5 ? "ok" : "warn" },
              { label: "Instance lifetime", detail: "Provisioned to terminated", value: hours(life), delta: delta(life), tone: life + 0.01 >= billed ? "ok" : "bad" },
              { label: "Jobs running", detail: idle ? hours(idle) + " idle on the instance" : "No idle time", value: hours(n(c, "scheduler_hours")), tone: "muted" },
              { label: "Contract billable", detail: rate ? "At " + money(rate) + "/h" : "Per contract terms", value: hours(billable), delta: delta(billable), tone: billable + 0.01 >= billed ? "ok" : "bad" },
            ],
            result: gap > 0 ? { label: "Not supported by the contract", value: money(gap), tone: "bad" } : { label: "Supported in full", value: money(0), tone: "ok" },
          },
          summary: s(a, "summary"),
        };
      }
      return { ...base, status, summary: s(a, "summary") };
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
      const total = lines.reduce((sum: number, l) => sum + dollars(s(l, "amount")), 0) || 1;
      return {
        ...base,
        stack: {
          total: s(r, "total"),
          parts: lines.map((l) => ({ label: s(l, "project_name"), share: dollars(s(l, "amount")) / total, display: s(l, "amount") })),
        },
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
      return {
        ...base,
        match: {
          head: { label: "Invoice " + (w.line?.externalLineId ?? w.item.invoiceLineId), detail: provider, value: money(w.line?.amountCents) },
          rows: [
            { label: "Pay", detail: "Supported by the contract", value: s(r, "undisputed_amount"), tone: "ok" },
            { label: "Dispute", detail: list(a, "clause_refs").length ? "Clauses " + list(a, "clause_refs").join(", ") : "Not supported", value: s(r, "disputed_amount"), tone: "bad" },
          ],
          result: { label: "Ask " + provider + " for a credit", value: s(r, "disputed_amount"), tone: "warn" },
        },
        summary: s(a, "rationale") || s(r, "liability_note") || undefined,
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
      const status = s(r, "status");
      const tone: Tone = status === "on_track" ? "ok" : status === "watch" ? "warn" : "bad";
      const cents = (k: string) => Math.round(dollars(s(r, k)) * 100);
      return {
        ...base,
        title: s(r, "project.name") + " is on pace for " + compactMoney(cents("projected_month_end")) + " of " + compactMoney(cents("monthly_budget")),
        status: { label: status.replace(/_/g, " "), tone },
        burn: {
          days: n(r, "days_in_month"),
          elapsed: n(r, "days_elapsed"),
          budget: cents("monthly_budget"),
          posted: cents("posted_to_date"),
          projected: cents("projected_month_end"),
          tone,
        },
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
    const provider = w.providers[w.item.providerId]?.name ?? w.item.providerId;
    frames.push({
      id: "intake-event",
      node: first,
      label: "Invoice",
      createdAt: w.item.createdAt,
      tone: "ok",
      spec: {
        eyebrow: "Provider feed · webhook",
        title: "Received " + line.externalLineId + " from " + provider,
        doc: {
          vendor: provider,
          logo: sourceForTool("get_work_item", w.item.providerId)?.logo,
          number: w.invoice?.invoiceNumber ?? line.invoiceId,
          meta: [
            { label: "Issued", value: dateOnly(w.invoice?.issuedAt) },
            { label: "Line", value: line.externalLineId },
            { label: "Service", value: dateTimeUtc(line.serviceStart) + " to " + dateTimeUtc(line.serviceEnd) },
          ],
          line: {
            description: line.description,
            qty: line.quantity.toLocaleString("en-US") + " " + line.unit,
            rate: money(line.unitPriceCents),
            amount: money(line.amountCents),
          },
        },
        checks: [{ label: "New event id", detail: "Not seen before; ingesting once", ok: true }],
      },
    });
  }

  const c = w.item.checks;
  const flagged = new Set(c.flags.map((f) => f.code));
  const flagMsg = (code: string) => c.flags.find((f) => f.code === code)?.message;
  let checks: Check[];
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
  } else {
    checks = [
      ...c.flags.map((f) => ({ label: f.code, detail: f.message, ok: false })),
      { label: "Amount matches commitment", detail: money(c.invoicedCents), ok: !flagged.has("AMOUNT_VARIANCE") },
    ];
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
      checks,
      summary: opened?.summary ?? undefined,
    },
  });
  return frames;
}

/* ------------------------------------------------------------- timeline and thread */

const tickFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const tickHourFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
const LANE_ORDER = ["invoice", "meter", "life", "jobs"];

/**
 * The billing period, provider meter, instance lifetime and jobs on one time
 * axis. A lane appears once the employee has read the record behind it.
 */
function timelineSpec(w: WorkspaceData, got: Set<string>): { spec: TimelineSpec; title: string; tone: Frame["tone"] } | null {
  const c = w.item.checks;
  const line = w.line;
  if (c.kind !== "instance" || !line) return null;
  const life = got.has("get_instance_lifecycle") && Boolean(c.provisionedAt);
  const meter = got.has("get_provider_usage");
  const contract = got.has("get_billing_terms");
  const ms = (iso: string) => Date.parse(iso);

  const points = [line.serviceStart, line.serviceEnd];
  if (life) {
    points.push(c.provisionedAt!);
    if (c.terminatedAt) points.push(c.terminatedAt);
    for (const j of w.jobs) points.push(j.startedAt, j.endedAt);
  }
  if (meter) for (const u of w.usage) points.push(u.usageStart, u.usageEnd);
  const times = points.map(ms).filter(Number.isFinite);
  let lo = Math.min(...times);
  let hi = Math.max(...times);
  const pad = (hi - lo) * 0.03 || 3_600_000;
  lo -= pad;
  hi += pad;
  const at = (t: number) => Math.min(1, Math.max(0, (t - lo) / (hi - lo)));
  const x = (iso: string) => at(ms(iso));

  const lanes: TimelineSpec["lanes"] = [
    { key: "invoice", label: "Invoice", value: hours(c.billedHours) + " billed", tone: "base", spans: [{ from: x(line.serviceStart), to: x(line.serviceEnd) }] },
  ];
  const marks: TimelineSpec["marks"] = [];
  const overHours = c.terminatedAt ? c.providerMeterHours - c.lifecycleHours : 0;

  if (meter) {
    const cut = c.terminatedAt ? ms(c.terminatedAt) : Infinity;
    const spans = w.usage.flatMap((u) => {
      const a = ms(u.usageStart);
      const b = ms(u.usageEnd);
      if (b <= cut) return [{ from: at(a), to: at(b), tone: "ok" as const }];
      if (a >= cut) return [{ from: at(a), to: at(b), tone: "bad" as const }];
      return [{ from: at(a), to: at(cut), tone: "ok" as const }, { from: at(cut), to: at(b), tone: "bad" as const }];
    });
    lanes.push({ key: "meter", label: "Provider meter", value: hours(c.providerMeterHours), tone: overHours > 0.5 ? "bad" : "ok", spans });
  }
  if (life) {
    const end = c.terminatedAt ?? line.serviceEnd;
    lanes.push({ key: "life", label: "Instance up", value: hours(c.lifecycleHours), tone: "ok", spans: [{ from: x(c.provisionedAt!), to: x(end) }] });
    lanes.push({
      key: "jobs",
      label: "Jobs running",
      value: hours(c.schedulerHours) + (c.idleHours > 0.01 ? " · " + hours(c.idleHours) + " idle" : ""),
      tone: "ok",
      spans: w.jobs.map((j) => ({ from: x(j.startedAt), to: x(j.endedAt) })),
    });
    if (c.terminatedAt) marks.push({ at: x(c.terminatedAt), label: "Terminated", tone: "base" });
  }
  if (contract && c.provisionedAt) {
    const billableEnd = at(ms(c.provisionedAt) + c.billableHours * 3_600_000);
    const near = marks.find((m) => Math.abs(m.at - billableEnd) < 0.04);
    if (near) near.label += " · billable ends";
    else marks.push({ at: billableEnd, label: "Billable ends", tone: "ok" });
  }
  lanes.sort((p, q2) => LANE_ORDER.indexOf(p.key) - LANE_ORDER.indexOf(q2.key));

  const fmt = hi - lo < 4 * 86_400_000 ? tickHourFmt : tickFmt;
  const ticks = [0.08, 0.36, 0.64, 0.92].map((f) => ({ at: f, label: fmt.format(new Date(lo + f * (hi - lo))) }));
  const overbilled = life && c.billedHours > c.lifecycleHours + 0.01;
  const title =
    meter && overHours > 0.5
      ? "Meter ran " + hours(overHours) + " past termination"
      : overbilled
        ? "Billed " + hours(c.billedHours) + "; the instance ran " + hours(c.lifecycleHours)
        : life
          ? "Instance ran " + hours(c.lifecycleHours) + "; billed " + hours(c.billedHours)
          : "Billing period for " + line.externalLineId;
  return { spec: { ticks, lanes, marks }, title, tone: (meter && overHours > 0.5) || overbilled ? "warn" : "ok" };
}

/** The dispute as one case: approval, the letter, the vendor's reply, the close. */
function threadSpec(w: WorkspaceData, send: ActivityRow, close?: ActivityRow, pkg?: ActivityRow): { spec: Partial<FrameSpec>; label: string; tone: Frame["tone"] } {
  const provider = w.providers[w.item.providerId]?.name ?? "Vendor";
  const d = w.dispute;
  const replied = Boolean(d && d.status !== "SUBMITTED");
  const credited = d?.status === "CREDIT_ACCEPTED";
  const approvedBy = pkg ? s(pkg.result, "approved_by") : "";
  const amount = d ? money(d.amountCents) : s(send.result, "disputed_amount");
  const steps: ThreadSpec["steps"] = [
    { label: approvedBy ? "Approved by " + approvedBy : "Approved", state: "done" },
    { label: "Sent", state: "done" },
    { label: replied ? (credited ? "Credited" : "Denied") : "Waiting on " + provider, state: replied ? "done" : "now", tone: replied ? (credited ? "ok" : "bad") : undefined },
    { label: "Closed", state: close ? "done" : replied ? "now" : "todo" },
  ];
  const messages: ThreadSpec["messages"] = [{ from: "Atlas Research Finance", to: provider + " billing", subject: s(send.args, "subject"), body: s(send.args, "message") }];
  if (replied && d) {
    const ref = d.creditMemoRef ? " (" + d.creditMemoRef + ")" : d.vendorReference ? " (" + d.vendorReference + ")" : "";
    messages.push({
      from: provider + " billing",
      to: "Vendor Liaison",
      body: credited ? "We reviewed the dispute and issued a credit memo for " + amount + ref + "." : "We reviewed the dispute and are upholding the charge" + ref + ".",
      tone: credited ? "ok" : "bad",
    });
  }
  const credit = close && s(close.result, "outcome") === "VENDOR_CREDIT";
  return {
    label: "Dispute",
    tone: replied && !credited ? "denied" : "ok",
    spec: {
      title: replied ? (credited ? provider + " credited " + amount : provider + " denied the dispute") : "Disputed " + amount + " with " + provider,
      thread: { steps, messages },
      draft: undefined,
      checks: close ? [{ label: credit ? "Payable reduced" : "Charged to the owning project", detail: s(close.result, "journal_entry_id"), ok: true }] : undefined,
      summary: close ? s(close.args, "summary") || undefined : undefined,
    },
  };
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
          { label: "Case reference", detail: w.dispute.vendorReference ?? "", ok: credited },
          ...(w.dispute.creditMemoRef ? [{ label: "Credit memo", detail: w.dispute.creditMemoRef, ok: true }] : []),
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

/** A frame as plain text, so an employee can talk about exactly what the controller is looking at. */
export function frameText(spec: FrameSpec): string {
  const out: string[] = [spec.eyebrow, spec.title];
  if (spec.status) out.push("Status: " + spec.status.label);
  if (spec.doc) out.push("Invoice " + spec.doc.number + " from " + spec.doc.vendor + ": " + spec.doc.line.description + ", " + spec.doc.line.qty + " at " + spec.doc.line.rate + " = " + spec.doc.line.amount);
  if (spec.timeline) {
    out.push("Timeline lanes: " + spec.timeline.lanes.map((l) => l.label + " " + l.value + (l.spans.some((s) => s.tone === "bad") ? " (part flagged)" : "")).join("; "));
    if (spec.timeline.marks.length) out.push("Marks: " + spec.timeline.marks.map((m) => m.label).join("; "));
  }
  if (spec.match) {
    out.push(spec.match.head.label + " (" + spec.match.head.detail + "): " + spec.match.head.value);
    for (const r of spec.match.rows) out.push("- " + r.label + ": " + r.value + (r.delta ? " (" + r.delta + ")" : "") + (r.detail ? ", " + r.detail : ""));
    out.push("Result: " + spec.match.result.label + " " + spec.match.result.value);
  }
  if (spec.stack) out.push("Split of " + spec.stack.total + ": " + spec.stack.parts.map((p) => p.label + " " + p.display + " (" + Math.round(p.share * 100) + "%)").join("; "));
  if (spec.burn) out.push("Burn: posted " + money(spec.burn.posted) + " by day " + spec.burn.elapsed + " of " + spec.burn.days + "; projected " + money(spec.burn.projected) + " vs budget " + money(spec.burn.budget));
  if (spec.thread) {
    out.push("Steps: " + spec.thread.steps.map((s) => s.label + " (" + s.state + ")").join("; "));
    for (const m of spec.thread.messages) out.push("Message from " + m.from + " to " + m.to + ": " + (m.subject ? m.subject + ". " : "") + m.body);
  }
  if (spec.query) out.push("Query: " + spec.query.text);
  if (spec.table) out.push(spec.table.cols.join(" | "), ...spec.table.rows.map((r) => r.join(" | ")));
  if (spec.bars) out.push(...spec.bars.map((b) => b.label + ": " + b.display));
  if (spec.ledger) out.push(...spec.ledger.lines.map((l) => l.account + " " + l.memo + " Dr " + (l.dr || "-") + " Cr " + (l.cr || "-")), spec.ledger.balanced ? "Balanced" : "Out of balance");
  if (spec.draft) out.push("Draft to " + spec.draft.to + ": " + spec.draft.subject + ". " + spec.draft.body);
  if (spec.checks) out.push(...spec.checks.map((c) => (c.ok === true ? "[pass] " : c.ok === false ? "[fail] " : "[info] ") + c.label + (c.detail ? ": " + c.detail : "")));
  if (spec.summary) out.push("Summary: " + spec.summary);
  if (spec.evidence?.length) out.push("Evidence: " + spec.evidence.join("; "));
  if (spec.sources?.length) out.push("Records read first: " + spec.sources.join(", "));
  return out.join("\n");
}

/** Reads that become source tags on the employee's next frame instead of frames of their own. */
const TAG_TOOLS = new Set([
  "get_work_item",
  "get_experiment",
  "get_billing_terms",
  "get_gpu_job_logs",
  "search_precedents",
  "get_allocation_policy",
  "get_project_budget",
  "get_posted_charges",
  "get_dispute_package",
]);

export function buildFrames(w: WorkspaceData): Frame[] {
  const frames: Frame[] = [...intakeFrames(w)];
  const deniedPostings: ActivityRow[] = [];
  const got = new Set(w.activity.filter((r) => r.toolName && r.status !== "denied" && r.status !== "error").map((r) => r.toolName!));
  /** Reads waiting to be tagged onto the employee's next frame. */
  const pending = new Map<string, ActivityRow[]>();
  /** Frames a later call folds into, keyed by employee and kind. */
  const open = new Map<string, Frame>();
  let timeline: Frame | null = null;
  const dispute: { frame?: Frame; send?: ActivityRow; close?: ActivityRow; pkg?: ActivityRow } = {};

  const toolFrame = (row: ActivityRow, agent: OrbitNodeId): Frame => {
    const src = sourceForTool(row.toolName, w.item.providerId);
    const spec = toolSpec(row, w);
    return {
      id: "act-" + row.id,
      node: agent,
      label: LABELS[row.toolName!] ?? row.toolName!,
      createdAt: row.createdAt,
      tone: "ok",
      spec: src ? { ...spec, source: { id: src.id, name: src.name, logo: src.logo, write: WRITE_TOOLS.has(row.toolName!) } } : spec,
    };
  };
  const fold = (f: Frame, rows: ActivityRow[]) => {
    f.members = [...(f.members ?? []), ...rows.map((r) => "act-" + r.id)];
  };
  const tag = (f: Frame, actorId: string) => {
    const reads = pending.get(actorId);
    if (!reads?.length) return;
    const labels = reads.map((r) => LABELS[r.toolName!] ?? r.toolName!);
    f.spec.sources = [...new Set([...(f.spec.sources ?? []), ...labels])];
    fold(f, reads);
    pending.delete(actorId);
  };

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
    const tool = row.toolName;
    if (!tool) continue;
    if (TAG_TOOLS.has(tool)) {
      if (tool === "get_dispute_package") dispute.pkg = row;
      pending.set(row.actorId, [...(pending.get(row.actorId) ?? []), row]);
      continue;
    }

    const key = (kind: string) => row.actorId + ":" + kind;
    let target: Frame;
    if ((tool === "get_instance_lifecycle" || tool === "get_provider_usage") && w.item.checks.kind === "instance") {
      if (timeline) fold(timeline, [row]);
      else frames.push((timeline = toolFrame(row, agent)));
      target = timeline;
    } else if (tool === "propose_adjustment" && open.has(key("alloc"))) {
      target = open.get(key("alloc"))!;
      open.delete(key("alloc"));
      fold(target, [row]);
      const auth = get(row.result, "standing_authorization");
      target.label = "Proposal";
      target.spec.title = row.title;
      target.spec.status = get(auth, "authorized") ? { label: "Covered by standing policy", tone: "ok" } : { label: "Needs controller approval", tone: "warn" };
      target.spec.summary = s(row.args, "rationale") || row.summary || target.spec.summary;
    } else if (tool === "record_budget_note" && open.has(key("burn"))) {
      target = open.get(key("burn"))!;
      open.delete(key("burn"));
      fold(target, [row]);
      target.spec.summary = s(row.args, "summary") || row.summary || target.spec.summary;
    } else if (tool === "close_dispute" && dispute.frame) {
      target = dispute.frame;
      dispute.close = row;
      fold(target, [row]);
    } else {
      target = toolFrame(row, agent);
      frames.push(target);
      if (tool === "calculate_cost_allocation") open.set(key("alloc"), target);
      if (tool === "forecast_project_burn") open.set(key("burn"), target);
      if (tool === "send_vendor_dispute") {
        dispute.frame = target;
        dispute.send = row;
      }
    }
    tag(target, row.actorId);
  }

  if (timeline) {
    const t = timelineSpec(w, got);
    if (t) {
      timeline.label = "Timeline";
      timeline.tone = t.tone;
      timeline.spec = {
        eyebrow: AGENT_NAME["agent.compute"] + " · lifecycle and meter",
        title: t.title,
        timeline: t.spec,
        sources: timeline.spec.sources,
      };
    }
  }
  if (dispute.frame && dispute.send) {
    const t = threadSpec(w, dispute.send, dispute.close, dispute.pkg);
    dispute.frame.label = t.label;
    dispute.frame.tone = t.tone;
    dispute.frame.spec = { ...dispute.frame.spec, ...t.spec };
  }

  // Reads with no frame after them yet. A running employee will tag them onto
  // its next frame; otherwise show what was read.
  const running = new Set(w.runs.filter((r) => r.status === "running").map((r) => r.agentId));
  for (const [actorId, reads] of pending) {
    if (running.has(actorId) || !NODE_OF[actorId]) continue;
    const last = reads.at(-1)!;
    frames.push({
      id: "act-" + reads[0].id,
      node: NODE_OF[actorId],
      label: "Reads",
      createdAt: last.createdAt,
      tone: "ok",
      members: reads.slice(1).map((r) => "act-" + r.id),
      spec: {
        eyebrow: (AGENT_NAME[actorId] ?? actorId) + " · reads",
        title: "Read " + reads.length + " record" + (reads.length > 1 ? "s" : ""),
        checks: reads.map((r) => ({ label: LABELS[r.toolName!] ?? r.toolName!, detail: r.title, ok: true })),
      },
    });
  }

  frames.push(...ledgerFrames(w, deniedPostings), ...(dispute.frame ? [] : vendorReplyFrames(w)), ...policyFrames(w));
  for (const id of Object.keys(NODE_OF)) {
    const live = liveFrame(w, id);
    if (live) frames.push(live);
  }
  return frames.sort((x, y) => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : 0));
}
