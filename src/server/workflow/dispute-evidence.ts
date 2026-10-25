import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../context";
import { gpuInstances, invoiceLines, invoices, lifecycleEvents, proposals, type ContractClause, type InstanceChecks } from "../db/schema";
import { formatCents } from "../domain/money";
import { contractForProvider } from "./checks";
import type { WorkItemRow } from "./work-items";

/*
 * The evidence pack that goes to a provider with a dispute. Every fact comes
 * from a system of record (the invoice line, the infrastructure controller's
 * lifecycle events and the provider's own API acknowledgment, the provider
 * meter, and the contract) and every number is computed here, not written by
 * an agent. The Cost Accountant chooses the clauses by reading the contract;
 * the gateway (checkCitedClauses) only lets through sections that exist in
 * that provider's contract. relevantClauses is the fixed fallback for disputes
 * drafted before agents chose their own clauses, and for the deterministic replay.
 */

export interface CitedClause extends ContractClause {
  why: string;
}

export interface DisputeEvidence {
  provider: string;
  invoice: {
    number: string;
    lineId: string;
    issuedAt: string | null;
    description: string;
    quantity: number;
    unit: string;
    unitPrice: string;
    amount: string;
    servicePeriod: string;
  };
  instance: {
    id: string;
    type: string;
    region: string | null;
    provisionedAt: string | null;
    stopRequestedAt: string | null;
    terminatedAt: string | null;
    terminationAck: string | null;
    lifecycleHours: number;
    providerMeterHours: number;
  } | null;
  calculation: string[];
  grounds: { code: string; statement: string }[];
  priorLines: string[];
  supported: string;
  invoiced: string;
  disputed: string;
  clauses: CitedClause[];
}

const fmt = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "not recorded");

function find(clauses: ContractClause[], words: string[]) {
  return clauses.find((c) => words.some((w) => c.title.toLowerCase().includes(w)));
}

/** "§ 4.2", "Section 4.2.", "clause 4.2" all mean 4.2. */
export function normalizeClauseRef(ref: string) {
  return ref.trim().replace(/^(§+|section|sec\.?|clause|article|art\.?)\s*/i, "").replace(/[.\s]+$/, "");
}

/** The clause that sets the deadline for raising a dispute, whatever it is called. */
export function isDisputeWindowClause(c: ContractClause) {
  return /disput|claim/i.test(c.title) || (/disput|claim|billing error/i.test(c.text) && /\bdays?\b/i.test(c.text));
}

export interface ClauseCheck {
  clauses: CitedClause[];
  dropped: { ref: string; reason: string }[];
  /** Cited clauses other than the dispute window: the actual grounds. */
  grounds: number;
}

/**
 * Gateway check on the clauses an agent cites: each must exist in this
 * provider's contract and come with a reason. The dispute-window clause is
 * added when the agent left it out, so the vendor sees the deadline.
 */
export function checkCitedClauses(contract: ContractClause[], cited: { ref: string; why: string }[], invoiceIssuedAt: string | null): ClauseCheck {
  const out: CitedClause[] = [];
  const dropped: { ref: string; reason: string }[] = [];
  for (const c of cited) {
    const ref = normalizeClauseRef(c.ref);
    const clause = contract.find((x) => normalizeClauseRef(x.ref) === ref);
    if (!clause) dropped.push({ ref: c.ref, reason: "Not a section of this contract." });
    else if (c.why.trim().length < 10) dropped.push({ ref: c.ref, reason: "No reason given for how it applies." });
    else if (!out.some((x) => x.ref === clause.ref)) out.push({ ...clause, why: c.why.trim().slice(0, 300) });
  }
  const window = contract.find(isDisputeWindowClause);
  if (window && !out.some((x) => x.ref === window.ref)) {
    out.push({ ...window, why: "Raised within the contract's dispute window" + (invoiceIssuedAt ? " (invoice issued " + invoiceIssuedAt.slice(0, 10) + ")." : ".") });
  }
  return { clauses: out, dropped, grounds: out.filter((c) => !isDisputeWindowClause(c)).length };
}

/** Fixed fallback: clauses picked by title keywords for what is wrong with the line, each with the reason it applies. */
export function relevantClauses(clauses: ContractClause[], checks: InstanceChecks, invoiceIssuedAt: string | null): CitedClause[] {
  const out: CitedClause[] = [];
  const add = (c: ContractClause | undefined, why: string) => {
    if (c && !out.some((x) => x.ref === c.ref)) out.push({ ...c, why });
  };
  const codes = new Set(checks.flags.map((f) => f.code));
  const duplicate = Boolean(checks.priorLineIds?.length);
  const overHours = checks.billedHours > checks.billableHours + 1e-6 && !duplicate;
  if (overHours) {
    add(find(clauses, ["termination"]), "Hours were billed after the instance's TERMINATED event.");
    add(find(clauses, ["metering"]), "Billable hours are the metered lifetime rounded to the billing increment.");
  }
  if (codes.has("RATE_MISMATCH")) add(find(clauses, ["rate"]), "The line uses a different rate than the contract rate card.");
  if (duplicate) add(find(clauses, ["metering"]), "Each metered hour of the instance can be billed once; these hours were already billed.");
  if (checks.billableHours > checks.lifecycleHours + 1 && overHours) {
    add(find(clauses, ["minimum"]), "The contract minimum is already included in the supported amount.");
  }
  add(find(clauses, ["dispute"]), "Raised within the contract's dispute window" + (invoiceIssuedAt ? " (invoice issued " + invoiceIssuedAt.slice(0, 10) + ")." : "."));
  return out;
}

/** The clauses on the latest live dispute proposal for this item, as the Cost Accountant chose them. */
function chosenClauses(ctx: AppContext, item: WorkItemRow, contract: ContractClause[]): CitedClause[] | null {
  const proposal = ctx.db
    .select()
    .from(proposals)
    .where(and(eq(proposals.workItemId, item.id), eq(proposals.kind, "VENDOR_DISPUTE"), inArray(proposals.status, ["APPROVED", "EXECUTED", "PENDING_APPROVAL", "DRAFT"])))
    .orderBy(desc(proposals.version))
    .get();
  const chosen = proposal?.payload.dispute?.clauses;
  if (!chosen?.length) return null;
  const out: CitedClause[] = [];
  for (const c of chosen) {
    const clause = contract.find((x) => x.ref === c.ref);
    if (clause) out.push({ ...clause, why: c.why });
  }
  return out.length ? out : null;
}

export function buildDisputeEvidence(ctx: AppContext, item: WorkItemRow): DisputeEvidence {
  const checks = item.checks;
  if (checks.kind !== "instance") throw new Error("Dispute evidence is built for instance charges");
  const line = ctx.db.select().from(invoiceLines).where(eq(invoiceLines.id, item.invoiceLineId)).get();
  const invoice = line ? ctx.db.select().from(invoices).where(eq(invoices.id, line.invoiceId)).get() : undefined;
  const contract = contractForProvider(ctx, item.providerId);
  const instance = ctx.db.select().from(gpuInstances).where(eq(gpuInstances.id, checks.instanceId)).get();
  const events = ctx.db.select().from(lifecycleEvents).where(eq(lifecycleEvents.instanceId, checks.instanceId)).orderBy(asc(lifecycleEvents.occurredAt)).all();
  const at = (type: string) => events.find((e) => e.eventType === type);
  const terminated = at("TERMINATED");
  const rate = formatCents(checks.contractRateCents);
  const duplicate = Boolean(checks.priorLineIds?.length);

  const calculation = [
    "Instance lifetime: " + checks.lifecycleHours + " h, from PROVISIONED " + fmt(checks.provisionedAt) + " to TERMINATED " + fmt(checks.terminatedAt) + ".",
    "Billable under the contract: " + checks.billableHours + " h (billed per " + contract.billingIncrementHours + " h increment" +
      (contract.minimumHours > 1 ? ", " + contract.minimumHours + " h minimum" : "") + ").",
    ...(duplicate ? ["Already billed on " + checks.priorLineIds!.join(", ") + ": " + checks.priorBilledHours + " h."] : []),
    "Supported by the contract: " + (duplicate ? Math.max(0, checks.billableHours - (checks.priorBilledHours ?? 0)) : checks.billableHours) + " h x " + rate + " = " + formatCents(checks.expectedCents) + ".",
    "Invoiced: " + checks.billedHours + " h x " + formatCents(checks.invoicedRateCents) + " = " + formatCents(checks.invoicedCents) + ".",
    "Disputed: " + formatCents(checks.invoicedCents) + " - " + formatCents(checks.expectedCents) + " = " + formatCents(checks.discrepancyCents) + ".",
  ];

  const grounds: { code: string; statement: string }[] = [];
  if (duplicate) {
    grounds.push({
      code: "DUPLICATE_CHARGE",
      statement: "Line " + checks.priorLineIds!.join(", ") + " already billed " + checks.priorBilledHours + " h for " + checks.instanceId + "; this line bills the same hours again.",
    });
  } else if (checks.billedHours > checks.billableHours + 1e-6) {
    grounds.push({
      code: "BILLED_AFTER_TERMINATION",
      statement:
        "Billed " + checks.billedHours + " h, but " + checks.instanceId + " was terminated at " + fmt(checks.terminatedAt) +
        (terminated?.reference ? " (your API acknowledgment " + terminated.reference + ")" : "") + " after " + checks.lifecycleHours + " h. " +
        (Math.round((checks.billedHours - checks.billableHours) * 100) / 100) + " h fall after termination." +
        (checks.providerMeterHours > checks.lifecycleHours + 0.5 ? " Your usage meter kept running to " + checks.providerMeterHours + " h after the instance was gone." : ""),
    });
  }
  if (checks.invoicedRateCents !== checks.contractRateCents) {
    grounds.push({
      code: "RATE_MISMATCH",
      statement: "Billed at " + formatCents(checks.invoicedRateCents) + "/h; the contract rate for " + checks.instanceType + " is " + rate + "/h.",
    });
  }

  return {
    provider: item.providerId,
    invoice: {
      number: invoice?.invoiceNumber ?? line?.invoiceId ?? "",
      lineId: line?.externalLineId ?? item.invoiceLineId,
      issuedAt: invoice?.issuedAt ?? null,
      description: line?.description ?? "",
      quantity: line?.quantity ?? checks.billedHours,
      unit: line?.unit ?? "instance-hour",
      unitPrice: formatCents(line?.unitPriceCents ?? checks.invoicedRateCents),
      amount: formatCents(line?.amountCents ?? checks.invoicedCents),
      servicePeriod: line ? fmt(line.serviceStart) + " to " + fmt(line.serviceEnd) : "",
    },
    instance: {
      id: checks.instanceId,
      type: checks.instanceType,
      region: instance?.region ?? null,
      provisionedAt: checks.provisionedAt,
      stopRequestedAt: at("STOP_REQUESTED")?.occurredAt ?? null,
      terminatedAt: checks.terminatedAt,
      terminationAck: terminated?.reference ?? null,
      lifecycleHours: checks.lifecycleHours,
      providerMeterHours: checks.providerMeterHours,
    },
    calculation,
    grounds,
    priorLines: checks.priorLineIds ?? [],
    supported: formatCents(checks.expectedCents),
    invoiced: formatCents(checks.invoicedCents),
    disputed: formatCents(checks.discrepancyCents),
    clauses: chosenClauses(ctx, item, contract.clauses) ?? relevantClauses(contract.clauses, checks, invoice?.issuedAt ?? null),
  };
}

/** Plain-text evidence section appended to the letter. */
export function renderEvidenceText(e: DisputeEvidence, contractName: string) {
  const i = e.instance;
  return [
    "EVIDENCE",
    "",
    "Invoice " + e.invoice.number + ", line " + e.invoice.lineId + (e.invoice.issuedAt ? " (issued " + e.invoice.issuedAt.slice(0, 10) + ")" : ""),
    "  " + e.invoice.description,
    "  " + e.invoice.quantity + " " + e.invoice.unit + " x " + e.invoice.unitPrice + " = " + e.invoice.amount + "; service " + e.invoice.servicePeriod,
    ...(i
      ? [
          "",
          "Instance " + i.id + " (" + i.type + (i.region ? ", " + i.region : "") + ")",
          "  PROVISIONED     " + fmt(i.provisionedAt),
          ...(i.stopRequestedAt ? ["  STOP_REQUESTED  " + fmt(i.stopRequestedAt)] : []),
          "  TERMINATED      " + fmt(i.terminatedAt) + (i.terminationAck ? "  (provider API acknowledgment " + i.terminationAck + ")" : ""),
          "  Lifetime " + i.lifecycleHours + " h; your usage meter recorded " + i.providerMeterHours + " h",
        ]
      : []),
    "",
    "Grounds",
    ...e.grounds.map((g) => "  - " + g.statement),
    "",
    "Calculation",
    ...e.calculation.map((c) => "  " + c),
    "",
    "Contract: " + contractName,
    ...e.clauses.map((c) => "  Section " + c.ref + " (" + c.title + "): \"" + c.text + "\"\n    Applies because: " + c.why),
  ].join("\n");
}

/** CSV attachment with the same facts, for the vendor's billing system. */
export function renderEvidenceCsv(e: DisputeEvidence) {
  const rows: [string, string][] = [
    ["invoice_number", e.invoice.number],
    ["invoice_line", e.invoice.lineId],
    ["billed_quantity", String(e.invoice.quantity)],
    ["billed_unit_price", e.invoice.unitPrice],
    ["billed_amount", e.invoice.amount],
    ["instance_id", e.instance?.id ?? ""],
    ["provisioned_at", e.instance?.provisionedAt ?? ""],
    ["terminated_at", e.instance?.terminatedAt ?? ""],
    ["termination_api_ack", e.instance?.terminationAck ?? ""],
    ["lifetime_hours", String(e.instance?.lifecycleHours ?? "")],
    ["provider_meter_hours", String(e.instance?.providerMeterHours ?? "")],
    ["contract_supported_amount", e.supported],
    ["disputed_amount", e.disputed],
    ["clauses_cited", e.clauses.map((c) => c.ref).join(" ")],
  ];
  return "field,value\n" + rows.map(([k, v]) => k + "," + JSON.stringify(v)).join("\n") + "\n";
}
