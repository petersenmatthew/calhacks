import { RESERVATION_METHODS, type AllocationMethod } from "../domain/allocation";
import { ACTOR } from "../security/actors";
import { invokeTool } from "./gateway";
import type { AgentRunContext } from "./tools";
import type { AppContext } from "../context";

/*
 * Deterministic replay mode. A fixed, reproducible decision policy that calls
 * exactly the same tools through the same gateway as the LLM agents. It exists
 * for demos without model credentials and for tests. It is labeled as such in
 * the UI and never presented as LLM output.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

class Caller {
  readonly evidence = new Set<string>();
  constructor(private ctx: AppContext, private run: AgentRunContext) {}

  async call(name: string, args: Json): Promise<Json> {
    const res = await this.try(name, args);
    if (!res.ok) throw new Error(name + " failed: " + res.error);
    return res;
  }

  async try(name: string, args: Json): Promise<Json> {
    const res = (await invokeTool(this.ctx, this.run, name, { work_item_id: this.run.workItemId, ...args })) as Json;
    for (const e of (res.evidence as { id: string }[] | undefined) ?? []) this.evidence.add(e.id);
    return res;
  }

  get ids() {
    return [...this.evidence];
  }
}

function pickClauses(clauses: { ref: string; title: string }[], words: string[]) {
  return clauses.filter((c) => words.some((w) => c.title.toLowerCase().includes(w))).map((c) => c.ref);
}

async function computePolicy(c: Caller) {
  const wi = await c.call("get_work_item", {});
  const checks = wi.deterministic_checks;
  if (checks.kind === "instance") {
    const life = await c.call("get_instance_lifecycle", { instance_id: checks.instanceId });
    for (const job of life.jobs) await c.call("get_gpu_job_logs", { job_id: job.job_id });
    for (const expId of [...new Set<string>(life.jobs.map((j: Json) => j.experiment_id))]) {
      await c.call("get_experiment", { experiment_id: expId });
    }
    const meter = await c.call("get_provider_usage", { instance_id: checks.instanceId });
    const terms = await c.call("get_billing_terms", { provider_id: wi.provider.id });
    const unexplained = checks.discrepancyCents >= 100;
    const anomalies: { code: string; description: string }[] = [];
    if (life.terminated_at && meter.total_hours > life.lifecycle_hours + 0.5) {
      anomalies.push({
        code: "METER_AFTER_TERMINATION",
        description:
          "Provider meter ran " + (meter.total_hours - life.lifecycle_hours).toFixed(1) + " h past the TERMINATED event at " + life.terminated_at + ".",
      });
    }
    if (checks.idleHours > 0.5) {
      anomalies.push({
        code: "IDLE_AFTER_JOB",
        description: "Instance stayed up " + checks.idleHours + " h after scheduler jobs ended; running time is billable while the instance is up.",
      });
    }
    if (checks.invoicedRateCents !== checks.contractRateCents) {
      anomalies.push({ code: "RATE_MISMATCH", description: "Billed rate differs from the contract rate." });
    }
    const clauses = unexplained
      ? pickClauses(terms.clauses, ["termination", "minimum", "metering"])
      : pickClauses(terms.clauses, ["idle", "minimum", "metering"]);
    const owner = checks.ownerProjectIds.length === 1 ? checks.ownerProjectIds[0] : null;
    const summary = unexplained
      ? "Instance " + checks.instanceId + " ran " + checks.lifecycleHours + " h from provisioning to termination, supporting " +
        checks.billableHours + " billable h (" + wi.amounts.contract_supported + "). The invoice bills " + checks.billedHours + " h (" +
        wi.amounts.invoiced + "); the extra " + (checks.billedHours - checks.billableHours) + " h fall after termination and no clause explains them."
      : "Instance " + checks.instanceId + " ran " + checks.lifecycleHours + " h and the invoice equals the contract-supported charge (" +
        wi.amounts.contract_supported + "). The training job ended after " + checks.schedulerHours + " h; the remaining " +
        checks.idleHours + " h of running time are billable under the contract, so the charge is explained.";
    await c.call("submit_compute_findings", {
      summary,
      charge_assessment: unexplained ? "not_explained" : "explained",
      owner_project_id: owner,
      anomalies,
      clause_refs: clauses,
      evidence_ids: c.ids,
    });
    await c.call("handoff_to_finance", {
      note: unexplained
        ? "Lifecycle and contract support " + wi.amounts.contract_supported + "; " + wi.amounts.discrepancy + " is unsupported. Recommend a vendor dispute."
        : "Charge is explained by the instance lifetime and contract terms. Recommend allocating the full amount to the owner.",
    });
    return;
  }

  const rel = await c.call("find_related_experiments", { reservation_id: checks.reservationId });
  for (const exp of rel.experiments.slice(0, 4)) await c.call("get_experiment", { experiment_id: exp.id });
  const terms = await c.call("get_billing_terms", { provider_id: wi.provider.id });
  const r = rel.reservation;
  const usageText = rel.usage_by_project
    .map((u: Json) => u.project_name + " " + u.gpu_hours + " GPU-h (" + u.share_of_reserved_pct + "%)")
    .join(", ");
  await c.call("submit_compute_findings", {
    summary:
      "Reservation " + r.id + " was booked by " + r.owner_project_name + " (" + rel.reserved_gpu_hours + " GPU-h, " + r.committed +
      "). Usage: " + usageText + "; " + rel.idle_gpu_hours + " GPU-h idle. Internal terms: " +
      (r.owner_accountable_for_idle ? "the reserving team is accountable for unused capacity." : "usage-based chargeback agreed."),
    charge_assessment: "not_applicable",
    owner_project_id: r.owner_project_id,
    anomalies: [
      { code: "SHARED_RESOURCE", description: rel.usage_by_project.length + " projects consumed the reservation." },
      { code: "IDLE_CAPACITY", description: rel.idle_gpu_hours + " reserved GPU-h were not used by any job." },
    ],
    clause_refs: pickClauses(terms.clauses, ["reserv"]),
    evidence_ids: c.ids,
  });
  await c.call("handoff_to_finance", {
    note: "Consumption reconstructed from scheduler logs. Reservation owner is " + r.owner_project_name + ". Allocation policy decision needed.",
  });
}

function interpretCorrection(feedback: Json, rejectedMethod: string): AllocationMethod {
  const directive = feedback.corrected_method as string | null;
  if (directive && (RESERVATION_METHODS as string[]).includes(directive)) return directive as AllocationMethod;
  const text = String(feedback.reason ?? "").toLowerCase();
  const mentionsOwner = /\bown(s|er|ers|ing)?\b|reserving team|reservation owner/.test(text);
  if (mentionsOwner && /entire|whole|all of (the )?reservation/.test(text)) return "owner_pays_all";
  if (mentionsOwner && /idle|unused|reserved capacity|capacity/.test(text)) return "owner_pays_idle";
  if (/usage|proportional/.test(text) && !mentionsOwner) return "usage_proportional";
  return rejectedMethod === "usage_proportional" ? "owner_pays_idle" : "usage_proportional";
}

async function financePolicy(c: Caller, run: AgentRunContext) {
  const wi = await c.call("get_work_item", {});
  const owner = wi.work_item.owner_project_id as string | null;
  if (owner) await c.call("get_project_budget", { project_id: owner });
  const compute = [...wi.findings].reverse().find((f: Json) => f.kind === "compute");

  if (wi.work_item.type === "BILLING_VARIANCE") {
    const policy = await c.call("get_allocation_policy", {});
    if (compute?.assessment === "not_explained") {
      await c.call("search_precedents", { query: wi.provider.name + " billing after termination dispute credit" });
      const dispute = await c.call("propose_vendor_dispute", {
        rationale:
          "Instance lifecycle and contract terms support " + wi.amounts.contract_supported + " of the " + wi.amounts.invoiced +
          " invoice. The provider billed beyond the TERMINATED event; billing ends at termination under the contract.",
        clause_refs: compute.data?.clause_refs ?? [],
        evidence_ids: c.ids,
      });
      await c.call("request_human_approval", {
        proposal_id: dispute.proposal_id,
        summary:
          "Dispute " + dispute.disputed_amount + " with " + wi.provider.name + " and allocate " + dispute.undisputed_amount +
          " to the owning project. Liability stays at " + wi.amounts.invoiced + " until a credit is issued.",
      });
      return;
    }
    const calc = await c.call("calculate_cost_allocation", { method: "single_owner" });
    const proposal = await c.call("propose_adjustment", {
      calculation_id: calc.calculation_id,
      rationale: "Charge explained by the instance lifetime and contract terms; allocate the full amount to the owning project.",
      policy_id: policy.applicable_policy?.id ?? null,
      evidence_ids: c.ids,
    });
    if (proposal.standing_authorization.authorized) {
      const posted = await c.try("submit_for_posting", { proposal_id: proposal.proposal_id });
      if (posted.ok) return;
    }
    await c.call("request_human_approval", { proposal_id: proposal.proposal_id, summary: "Allocate " + calc.total + " to the owning project." });
    return;
  }

  const pol = await c.call("get_allocation_policy", {});
  const precedents = await c.call("search_precedents", { query: "shared reservation allocation idle capacity owner controller correction" });
  const latest = [...wi.proposals].reverse()[0] as Json | undefined;
  const feedback =
    latest && (latest.status === "REJECTED" || latest.status === "CHANGES_REQUESTED")
      ? [...wi.controller_feedback].reverse().find((f: Json) => f.proposal_id === latest.id)
      : undefined;
  const applicable = pol.applicable_policy as Json | null;

  let method: AllocationMethod;
  let policyId: string | null = null;
  if (feedback) {
    method = interpretCorrection(feedback, latest?.method ?? "usage_proportional");
    if (applicable && applicable.method === method) policyId = applicable.id;
  } else {
    method = (applicable?.method as AllocationMethod) ?? "usage_proportional";
    policyId = applicable?.id ?? null;
  }
  const calc = await c.call("calculate_cost_allocation", { method });
  if (!feedback && !pol.fit_with_reservation_terms.consistent) {
    await c.call("calculate_cost_allocation", { method: method === "owner_pays_idle" ? "usage_proportional" : "owner_pays_idle" });
  }
  const conflictText = pol.fit_with_reservation_terms.consistent ? "" : " Conflict: " + pol.fit_with_reservation_terms.conflicts.join(" ");
  const proposal = await c.call("propose_adjustment", {
    calculation_id: calc.calculation_id,
    rationale: feedback
      ? "Controller feedback (" + feedback.approval_id + "): " + feedback.reason + " Recalculated as: " + calc.method_label + "."
      : "Follows " + (applicable ? applicable.id : "historical practice") + " (" + calc.method_label + ")." + conflictText,
    policy_id: policyId,
    evidence_ids: c.ids,
  });
  if (feedback && (!applicable || applicable.method !== method)) {
    const precedentIds = (precedents.matches as Json[]).map((m) => m.id as string);
    await c.call("propose_policy", {
      method,
      statement:
        method === "owner_pays_idle"
          ? "For shared GPU reservations, each project pays for the GPU-hours it used at the reservation rate, and unused reserved capacity is charged to the project that owns the reservation."
          : "For shared GPU reservations, allocate the charge as follows: " + calc.method_label + ".",
      rationale: "Learned from controller correction on " + run.workItemId + ": " + feedback.reason,
      precedent_ids: precedentIds,
      evidence_ids: c.ids,
    });
  }
  // Follow the written policy when one is cited; the ledger gateway decides whether it really covers this case.
  if (proposal.standing_authorization.authorized || policyId) {
    const posted = await c.try("submit_for_posting", { proposal_id: proposal.proposal_id });
    if (posted.ok) return;
  }
  await c.call("request_human_approval", {
    proposal_id: proposal.proposal_id,
    summary:
      calc.method_label + ": " + calc.lines.map((l: Json) => l.project_name + " " + l.amount).join(", ") + "." +
      (feedback ? " Revised after controller feedback." : conflictText),
  });
}

export async function runDeterministicAgent(ctx: AppContext, run: AgentRunContext) {
  const caller = new Caller(ctx, run);
  if (run.agentId === ACTOR.compute) await computePolicy(caller);
  else if (run.agentId === ACTOR.finance) await financePolicy(caller, run);
  else throw new Error("No deterministic policy for " + run.agentId);
}
