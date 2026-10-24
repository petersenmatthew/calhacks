import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/* ------------------------------------------------------------------ */
/* Shared JSON shapes                                                  */
/* ------------------------------------------------------------------ */

export interface ContractClause {
  ref: string;
  title: string;
  text: string;
}

export interface JobLogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
}

export type CheckFlagCode =
  | "AMOUNT_VARIANCE"
  | "QUANTITY_EXCEEDS_LIFECYCLE"
  | "RATE_MISMATCH"
  | "IDLE_TIME"
  | "METER_MISMATCH"
  | "NO_TERMINATION_RECORD"
  | "SHARED_RESOURCE"
  | "MISSING_OWNER"
  | "DUPLICATE_CHARGE";

export interface CheckFlag {
  code: CheckFlagCode;
  severity: "high" | "medium" | "low";
  message: string;
}

export interface InstanceChecks {
  kind: "instance";
  instanceId: string;
  instanceType: string;
  contractId: string;
  contractRateCents: number;
  invoicedRateCents: number;
  provisionedAt: string | null;
  terminatedAt: string | null;
  lifecycleHours: number;
  billableHours: number;
  billedHours: number;
  schedulerHours: number;
  idleHours: number;
  providerMeterHours: number;
  expectedCents: number;
  invoicedCents: number;
  discrepancyCents: number;
  ownerProjectIds: string[];
  experimentIds: string[];
  jobIds: string[];
  flags: CheckFlag[];
  /** Earlier invoice lines that already billed this instance. */
  priorLineIds?: string[];
  priorBilledHours?: number;
}

export interface ReservationChecks {
  kind: "reservation";
  reservationId: string;
  ownerProjectId: string;
  contractId: string;
  expectedCents: number;
  invoicedCents: number;
  discrepancyCents: number;
  reservedGpuHours: number;
  usedGpuHours: number;
  idleGpuHours: number;
  usageByProject: { projectId: string; gpuHours: number }[];
  experimentIds: string[];
  jobIds: string[];
  flags: CheckFlag[];
}

export type ReconciliationChecks = InstanceChecks | ReservationChecks;

export interface AllocationLine {
  projectId: string;
  basis: string;
  weight: number;
  amountCents: number;
}

export interface JournalLineDraft {
  accountCode: string;
  projectId: string | null;
  debitCents: number;
  creditCents: number;
  memo: string;
}

export interface ProposalPayload {
  method: string;
  calculationId: string | null;
  allocation: AllocationLine[];
  totalCents: number;
  journalPreview: JournalLineDraft[];
  dispute?: {
    providerId: string;
    invoiceLineId: string;
    disputedCents: number;
    undisputedCents: number;
    invoicedCents: number;
    reason: string;
    clauseRefs: string[];
  };
  policyFit?: { policyId: string | null; consistent: boolean; conflicts: string[] };
}

export interface PolicyRule {
  method: string;
  autoPostLimitCents: number;
  appliesTo: string;
  conditions: string[];
  /** Materiality policies: largest per-line variance accepted without a dispute. */
  thresholdCents?: number;
}

/* ------------------------------------------------------------------ */
/* Infrastructure                                                      */
/* ------------------------------------------------------------------ */

export const counters = sqliteTable("counters", {
  name: text("name").primaryKey(),
  value: integer("value").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
});

/* ------------------------------------------------------------------ */
/* Simulated company environment (source systems)                      */
/* ------------------------------------------------------------------ */

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  lead: text("lead").notNull(),
  costCenter: text("cost_center").notNull(),
  monthlyBudgetCents: integer("monthly_budget_cents").notNull(),
});

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(),
});

export const contracts = sqliteTable("contracts", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  name: text("name").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  /** cents per instance-hour, keyed by instance type */
  rateCard: text("rate_card", { mode: "json" }).$type<Record<string, number>>().notNull(),
  billingIncrementHours: real("billing_increment_hours").notNull(),
  minimumHours: real("minimum_hours").notNull(),
  idleBillable: integer("idle_billable", { mode: "boolean" }).notNull(),
  reservationsBilledInFull: integer("reservations_billed_in_full", { mode: "boolean" }).notNull(),
  clauses: text("clauses", { mode: "json" }).$type<ContractClause[]>().notNull(),
});

export const experiments = sqliteTable("experiments", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),
  name: text("name").notNull(),
  owner: text("owner").notNull(),
  description: text("description").notNull(),
  tracker: text("tracker").notNull(),
});

export const reservations = sqliteTable("reservations", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  ownerProjectId: text("owner_project_id").notNull(),
  requestedBy: text("requested_by").notNull(),
  gpuType: text("gpu_type").notNull(),
  gpuCount: integer("gpu_count").notNull(),
  hours: real("hours").notNull(),
  rateCentsPerGpuHour: integer("rate_cents_per_gpu_hour").notNull(),
  committedCents: integer("committed_cents").notNull(),
  startAt: text("start_at").notNull(),
  endAt: text("end_at").notNull(),
  period: text("period").notNull(),
  ownerAccountableForIdle: integer("owner_accountable_for_idle", { mode: "boolean" }).notNull(),
  internalTerms: text("internal_terms").notNull(),
});

export const gpuInstances = sqliteTable("gpu_instances", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  instanceType: text("instance_type").notNull(),
  gpuCount: integer("gpu_count").notNull(),
  region: text("region").notNull(),
});

export const lifecycleEvents = sqliteTable(
  "lifecycle_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    instanceId: text("instance_id").notNull(),
    eventType: text("event_type").notNull(),
    occurredAt: text("occurred_at").notNull(),
    source: text("source").notNull(),
    reference: text("reference"),
  },
  (t) => [index("lifecycle_instance_idx").on(t.instanceId)],
);

export const computeJobs = sqliteTable(
  "compute_jobs",
  {
    id: text("id").primaryKey(),
    experimentId: text("experiment_id").notNull(),
    instanceId: text("instance_id"),
    reservationId: text("reservation_id"),
    submittedBy: text("submitted_by").notNull(),
    gpus: integer("gpus").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at").notNull(),
    status: text("status").notNull(),
    logs: text("logs", { mode: "json" }).$type<JobLogEntry[]>().notNull(),
  },
  (t) => [index("jobs_instance_idx").on(t.instanceId), index("jobs_reservation_idx").on(t.reservationId)],
);

export const providerUsage = sqliteTable("provider_usage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId: text("provider_id").notNull(),
  instanceId: text("instance_id").notNull(),
  usageStart: text("usage_start").notNull(),
  usageEnd: text("usage_end").notNull(),
  hours: real("hours").notNull(),
  sourceRef: text("source_ref").notNull(),
});

export const invoices = sqliteTable("invoices", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  invoiceNumber: text("invoice_number").notNull(),
  period: text("period").notNull(),
  issuedAt: text("issued_at").notNull(),
});

export const invoiceLines = sqliteTable(
  "invoice_lines",
  {
    id: text("id").primaryKey(),
    invoiceId: text("invoice_id").notNull(),
    externalLineId: text("external_line_id").notNull(),
    lineType: text("line_type").notNull(), // instance | reservation
    instanceId: text("instance_id"),
    reservationId: text("reservation_id"),
    description: text("description").notNull(),
    quantity: real("quantity").notNull(),
    unit: text("unit").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    amountCents: integer("amount_cents").notNull(),
    period: text("period").notNull(),
    serviceStart: text("service_start").notNull(),
    serviceEnd: text("service_end").notNull(),
  },
  (t) => [uniqueIndex("invoice_lines_external_idx").on(t.externalLineId)],
);

export const precedents = sqliteTable("precedents", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  decidedAt: text("decided_at").notNull(),
  decidedBy: text("decided_by").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
  details: text("details", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  source: text("source").notNull(), // seed | controller_decision
  workItemId: text("work_item_id"),
});

export const ledgerAccounts = sqliteTable("ledger_accounts", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
});

export const journalEntries = sqliteTable(
  "journal_entries",
  {
    id: text("id").primaryKey(),
    period: text("period").notNull(),
    postedAt: text("posted_at").notNull(),
    memo: text("memo").notNull(),
    source: text("source").notNull(), // erp_ap | experiment_ledger
    workItemId: text("work_item_id"),
    invoiceLineId: text("invoice_line_id"),
    proposalId: text("proposal_id"),
    approvalId: text("approval_id"),
    policyId: text("policy_id"),
    authorization: text("authorization").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    postedBy: text("posted_by").notNull(),
    totalCents: integer("total_cents").notNull(),
  },
  (t) => [uniqueIndex("journal_idempotency_idx").on(t.idempotencyKey)],
);

export const journalLines = sqliteTable(
  "journal_lines",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entryId: text("entry_id").notNull(),
    lineNo: integer("line_no").notNull(),
    accountCode: text("account_code").notNull(),
    projectId: text("project_id"),
    debitCents: integer("debit_cents").notNull(),
    creditCents: integer("credit_cents").notNull(),
    memo: text("memo").notNull(),
  },
  (t) => [index("journal_lines_entry_idx").on(t.entryId)],
);

/* ------------------------------------------------------------------ */
/* System of work                                                      */
/* ------------------------------------------------------------------ */

export const actors = sqliteTable("actors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // agent | human | system
  role: text("role").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
});

export const ingestionEvents = sqliteTable(
  "ingestion_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    externalEventId: text("external_event_id").notNull(),
    source: text("source").notNull(),
    receivedAt: text("received_at").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    invoiceLineId: text("invoice_line_id"),
    workItemId: text("work_item_id"),
    outcome: text("outcome").notNull(),
    duplicateCount: integer("duplicate_count").notNull().default(0),
  },
  (t) => [uniqueIndex("ingestion_external_idx").on(t.externalEventId)],
);

export const reconciliations = sqliteTable("reconciliations", {
  invoiceLineId: text("invoice_line_id").primaryKey(),
  period: text("period").notNull(),
  status: text("status").notNull(), // MATCHED | EXCEPTION | RESOLVED
  outcome: text("outcome").notNull(),
  expectedCents: integer("expected_cents").notNull(),
  invoicedCents: integer("invoiced_cents").notNull(),
  varianceCents: integer("variance_cents").notNull(),
  checks: text("checks", { mode: "json" }).$type<ReconciliationChecks>().notNull(),
  workItemId: text("work_item_id"),
  resolvedAt: text("resolved_at"),
});

export const workItems = sqliteTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(), // BILLING_VARIANCE | SHARED_ALLOCATION
    title: text("title").notNull(),
    period: text("period").notNull(),
    providerId: text("provider_id").notNull(),
    invoiceLineId: text("invoice_line_id").notNull(),
    instanceId: text("instance_id"),
    reservationId: text("reservation_id"),
    ownerProjectId: text("owner_project_id"),
    amountCents: integer("amount_cents").notNull(),
    expectedCents: integer("expected_cents").notNull(),
    invoicedCents: integer("invoiced_cents").notNull(),
    discrepancyCents: integer("discrepancy_cents").notNull(),
    checks: text("checks", { mode: "json" }).$type<ReconciliationChecks>().notNull(),
    state: text("state").notNull(),
    priority: integer("priority").notNull(),
    assignedAgentId: text("assigned_agent_id"),
    latestAction: text("latest_action").notNull(),
    outcome: text("outcome"),
    pendingQuestion: text("pending_question", { mode: "json" }).$type<{
      agentId: string;
      question: string;
      askedBy: string;
    } | null>(),
    agentRunCount: integer("agent_run_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (t) => [index("work_items_state_idx").on(t.state)],
);

export const workItemTransitions = sqliteTable("work_item_transitions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workItemId: text("work_item_id").notNull(),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  actorId: text("actor_id").notNull(),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull(),
});

export const findings = sqliteTable("findings", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  agentId: text("agent_id").notNull(),
  runId: text("run_id"),
  kind: text("kind").notNull(), // compute | finance | human
  summary: text("summary").notNull(),
  assessment: text("assessment"),
  data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  evidenceIds: text("evidence_ids", { mode: "json" }).$type<string[]>().notNull(),
  createdAt: text("created_at").notNull(),
});

export const evidence = sqliteTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    workItemId: text("work_item_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    label: text("label").notNull(),
    snapshot: text("snapshot", { mode: "json" }).$type<unknown>().notNull(),
    collectedBy: text("collected_by").notNull(),
    runId: text("run_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("evidence_source_idx").on(t.workItemId, t.sourceType, t.sourceId)],
);

export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workItemId: text("work_item_id"),
    runId: text("run_id"),
    actorId: text("actor_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    status: text("status").notNull(), // ok | error | denied | info | pending
    toolName: text("tool_name"),
    args: text("args", { mode: "json" }).$type<unknown>(),
    result: text("result", { mode: "json" }).$type<unknown>(),
    evidenceIds: text("evidence_ids", { mode: "json" }).$type<string[]>().notNull(),
    changes: text("changes", { mode: "json" }).$type<string[]>().notNull(),
    mode: text("mode"),
    durationMs: integer("duration_ms"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("activity_work_item_idx").on(t.workItemId)],
);

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  agentId: text("agent_id").notNull(),
  mode: text("mode").notNull(), // llm | deterministic
  model: text("model"),
  task: text("task").notNull(),
  status: text("status").notNull(), // running | completed | failed | cancelled
  terminalAction: text("terminal_action"),
  toolCalls: integer("tool_calls").notNull().default(0),
  error: text("error"),
  usage: text("usage", { mode: "json" }).$type<Record<string, number> | null>(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});

export const jobs = sqliteTable("jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  workItemId: text("work_item_id").notNull(),
  kind: text("kind").notNull(), // AGENT_RUN | EXECUTE_DECISION
  agentId: text("agent_id"),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull(), // queued | running | done | failed | cancelled
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
});

export const proposals = sqliteTable("proposals", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  kind: text("kind").notNull(), // ALLOCATION | VENDOR_DISPUTE
  version: integer("version").notNull(),
  status: text("status").notNull(), // DRAFT | PENDING_APPROVAL | APPROVED | REJECTED | CHANGES_REQUESTED | SUPERSEDED | EXECUTED
  summary: text("summary").notNull(),
  rationale: text("rationale").notNull(),
  method: text("method").notNull(),
  policyId: text("policy_id"),
  payload: text("payload", { mode: "json" }).$type<ProposalPayload>().notNull(),
  evidenceIds: text("evidence_ids", { mode: "json" }).$type<string[]>().notNull(),
  authorization: text("authorization"),
  createdBy: text("created_by").notNull(),
  supersedesId: text("supersedes_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const approvalRequests = sqliteTable("approval_requests", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  subjectType: text("subject_type").notNull(), // PROPOSAL | POLICY
  subjectId: text("subject_id").notNull(),
  requestedBy: text("requested_by").notNull(),
  requiredRole: text("required_role").notNull(),
  status: text("status").notNull(), // PENDING | APPROVED | REJECTED | CHANGES_REQUESTED
  summary: text("summary").notNull(),
  decidedBy: text("decided_by"),
  decisionReason: text("decision_reason"),
  directive: text("directive"),
  createdAt: text("created_at").notNull(),
  decidedAt: text("decided_at"),
});

export const policies = sqliteTable("policies", {
  id: text("id").primaryKey(),
  policyKey: text("policy_key").notNull(),
  version: integer("version").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(), // PROPOSED | APPROVED | REJECTED | SUPERSEDED
  statement: text("statement").notNull(),
  rule: text("rule", { mode: "json" }).$type<PolicyRule>().notNull(),
  rationale: text("rationale").notNull(),
  evidenceIds: text("evidence_ids", { mode: "json" }).$type<string[]>().notNull(),
  precedentIds: text("precedent_ids", { mode: "json" }).$type<string[]>().notNull(),
  learnedFromWorkItemId: text("learned_from_work_item_id"),
  proposedBy: text("proposed_by").notNull(),
  approvedBy: text("approved_by"),
  approvalId: text("approval_id"),
  supersedesId: text("supersedes_id"),
  createdAt: text("created_at").notNull(),
  approvedAt: text("approved_at"),
});

export const vendorDisputes = sqliteTable("vendor_disputes", {
  id: text("id").primaryKey(),
  workItemId: text("work_item_id").notNull(),
  providerId: text("provider_id").notNull(),
  invoiceLineId: text("invoice_line_id").notNull(),
  proposalId: text("proposal_id").notNull(),
  approvalId: text("approval_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  status: text("status").notNull(), // SUBMITTED | CREDIT_ACCEPTED | DENIED
  reason: text("reason").notNull(),
  vendorReference: text("vendor_reference"),
  submittedAt: text("submitted_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: text("ts").notNull(),
    actorId: text("actor_id").notNull(),
    actorKind: text("actor_kind").notNull(),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(), // ALLOWED | DENIED | FAILED
    category: text("category").notNull(), // read | write | decision | posting | security | system
    targetType: text("target_type"),
    targetId: text("target_id"),
    workItemId: text("work_item_id"),
    policyId: text("policy_id"),
    approvalId: text("approval_id"),
    rule: text("rule"),
    evidenceIds: text("evidence_ids", { mode: "json" }).$type<string[]>().notNull(),
    details: text("details", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [index("audit_work_item_idx").on(t.workItemId)],
);

/* ------------------------------------------------------------------ */
/* Autonomy: feed sync, follow-ups, and ERP history                    */
/* ------------------------------------------------------------------ */

/** Simulated provider billing outbox. Rows become visible to sync at publish_at (business time). */
export const feedEvents = sqliteTable(
  "feed_events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    externalEventId: text("external_event_id").notNull(),
    publishAt: text("publish_at").notNull(),
    label: text("label").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("feed_events_external_idx").on(t.externalEventId), index("feed_events_source_idx").on(t.source, t.seq)],
);

/** Last position read from each source, so a re-sync never re-reads or duplicates. */
export const syncCursors = sqliteTable("sync_cursors", {
  source: text("source").primaryKey(),
  cursor: text("cursor"),
  syncedAt: text("synced_at").notNull(),
  lastCount: integer("last_count").notNull().default(0),
  totalCount: integer("total_count").notNull().default(0),
  lastError: text("last_error"),
});

/** Time-based actions the system took on its own (reminders, escalations, vendor chases). One row per key. */
export const followUps = sqliteTable(
  "follow_ups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: text("key").notNull(),
    kind: text("kind").notNull(), // APPROVAL_REMINDER | APPROVAL_ESCALATION | DISPUTE_CHASE | DISPUTE_ESCALATION
    workItemId: text("work_item_id"),
    subjectId: text("subject_id").notNull(),
    actorId: text("actor_id").notNull(),
    businessAt: text("business_at").notNull(),
    createdAt: text("created_at").notNull(),
    details: text("details", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [uniqueIndex("follow_ups_key_idx").on(t.key)],
);

/** Past AP lines and how each variance was resolved (simulated ERP export the agents learn from). */
export const erpApHistory = sqliteTable("erp_ap_history", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  invoiceNumber: text("invoice_number").notNull(),
  lineRef: text("line_ref").notNull(),
  period: text("period").notNull(),
  description: text("description").notNull(),
  invoicedCents: integer("invoiced_cents").notNull(),
  expectedCents: integer("expected_cents").notNull(),
  varianceCents: integer("variance_cents").notNull(),
  resolution: text("resolution").notNull(), // PAID_AS_BILLED | DISPUTED_CREDITED | DISPUTED_DENIED
  resolvedBy: text("resolved_by").notNull(),
  note: text("note").notNull(),
  resolvedAt: text("resolved_at").notNull(),
});
