import { METHOD_LABELS, RESERVATION_METHODS, type AllocationMethod } from "../domain/allocation";
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
    if (checks.priorLineIds?.length) {
      anomalies.push({
        code: "DUPLICATE_LINE",
        description: "Line " + checks.priorLineIds.join(", ") + " already billed " + checks.priorBilledHours + " h for " + checks.instanceId + ".",
      });
    }
    // Owner comes from the experiment tracker, or from the controller's answer when the tracker has none.
    const named = (wi.findings as Json[])
      .filter((f) => f.kind === "human")
      .flatMap((f) => String(f.summary).match(/PRJ-[A-Z]+/g) ?? []);
    const owner = checks.ownerProjectIds.length === 1 ? checks.ownerProjectIds[0] : (named.at(-1) ?? null);
    if (!owner) {
      const exps = (life.jobs as Json[]).map((j) => j.experiment_id).join(", ");
      await c.call("request_human_info", {
        question:
          "No project owns " + exps + " on " + checks.instanceId + " (" + wi.amounts.invoiced + "). Which project should carry this charge? Reply with its project id, e.g. PRJ-FLM.",
      });
      return;
    }
    const summary = checks.priorLineIds?.length
      ? "Instance " + checks.instanceId + " supports " + checks.billableHours + " billable h, and line " + checks.priorLineIds.join(", ") +
        " already billed " + checks.priorBilledHours + " h. This line bills " + checks.billedHours + " h (" + wi.amounts.invoiced +
        ") again; " + wi.amounts.discrepancy + " is a duplicate charge."
      : unexplained
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

async function financePolicy(c: Caller) {
  const wi = await c.call("get_work_item", {});
  const owner = wi.work_item.owner_project_id as string | null;
  if (owner) await c.call("get_project_budget", { project_id: owner });
  const compute = [...wi.findings].reverse().find((f: Json) => f.kind === "compute");

  if (wi.work_item.type === "BILLING_VARIANCE") {
    const policy = await c.call("get_allocation_policy", {});
    const latest = [...wi.proposals].reverse()[0] as Json | undefined;
    const disputeRejected = latest?.kind === "VENDOR_DISPUTE" && (latest.status === "REJECTED" || latest.status === "CHANGES_REQUESTED");
    if (disputeRejected) {
      // The controller turned down the dispute: allocate the full invoice to the owner and ask again.
      const feedback = [...wi.controller_feedback].reverse().find((f: Json) => f.proposal_id === latest.id);
      const calc = await c.call("calculate_cost_allocation", { method: "single_owner" });
      const proposal = await c.call("propose_adjustment", {
        calculation_id: calc.calculation_id,
        rationale: "Controller declined dispute " + latest.id + (feedback?.reason ? ": " + feedback.reason : ".") + " Allocating the full charge to the owning project.",
        policy_id: null,
        evidence_ids: c.ids,
      });
      await c.call("request_human_approval", { proposal_id: proposal.proposal_id, summary: "Allocate " + calc.total + " to the owning project. Revised after the dispute was declined." });
      return;
    }
    const materiality = policy.materiality_policy as Json | null;
    if (compute?.assessment === "not_explained" && materiality?.applies_to_this_item) {
      const calc = await c.call("calculate_cost_allocation", { method: "single_owner" });
      const proposal = await c.call("propose_adjustment", {
        calculation_id: calc.calculation_id,
        rationale:
          "The " + wi.amounts.discrepancy + " variance is at or below the " + materiality.threshold + " materiality threshold in " +
          materiality.id + ", learned from how the controller resolved past variances. Accept it and charge the full " +
          wi.amounts.invoiced + " to the owning project instead of opening a dispute.",
        policy_id: materiality.id,
        evidence_ids: c.ids,
      });
      if (proposal.standing_authorization.authorized) {
        const posted = await c.try("submit_for_posting", { proposal_id: proposal.proposal_id });
        if (posted.ok) return;
      }
      await c.call("request_human_approval", { proposal_id: proposal.proposal_id, summary: "Accept a " + wi.amounts.discrepancy + " variance below materiality." });
      return;
    }
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
  await c.call("search_precedents", { query: "shared reservation allocation idle capacity owner controller correction" });
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

/** Policy Analyst: turn a controller correction into a reusable policy, then hand the rework to the Cost Accountant. */
async function policyAnalystPolicy(c: Caller, run: AgentRunContext) {
  const wi = await c.call("get_work_item", {});
  const latest = [...wi.proposals].reverse()[0] as Json | undefined;
  const feedback =
    latest && (latest.status === "REJECTED" || latest.status === "CHANGES_REQUESTED")
      ? [...wi.controller_feedback].reverse().find((f: Json) => f.proposal_id === latest.id)
      : undefined;
  if (!feedback || wi.work_item.type !== "SHARED_ALLOCATION") {
    await c.call("handoff_to_finance", {
      note: feedback
        ? "Controller feedback on " + latest!.id + ": " + feedback.reason + " No reusable allocation policy applies; rework the proposal."
        : "No controller correction to learn from on this item.",
    });
    return;
  }
  const pol = await c.call("get_allocation_policy", {});
  const precedents = await c.call("search_precedents", { query: "shared reservation allocation idle capacity owner controller correction" });
  const method = interpretCorrection(feedback, latest?.method ?? "usage_proportional");
  const applicable = pol.applicable_policy as Json | null;
  let note: string;
  if (!applicable || applicable.method !== method) {
    const proposed = await c.call("propose_policy", {
      method,
      statement:
        method === "owner_pays_idle"
          ? "For shared GPU reservations, each project pays for the GPU-hours it used at the reservation rate, and unused reserved capacity is charged to the project that owns the reservation."
          : "For shared GPU reservations, allocate the charge as follows: " + METHOD_LABELS[method] + ".",
      rationale: "Learned from controller correction on " + run.workItemId + ": " + feedback.reason,
      precedent_ids: (precedents.matches as Json[]).map((m) => m.id as string),
      evidence_ids: c.ids,
    });
    note = "The controller wants: " + METHOD_LABELS[method] + ". I proposed " + proposed.policy_id + " for approval. Rework the allocation with this method.";
  } else {
    note = "Approved policy " + applicable.id + " already uses " + METHOD_LABELS[method] + ". Rework the allocation with it.";
  }
  await c.call("handoff_to_finance", { note });
}

/** Vendor Liaison: send the approved dispute, then close the case when the vendor replies. */
async function vendorPolicy(c: Caller) {
  const wi = await c.call("get_work_item", {});
  const pkg = await c.call("get_dispute_package", {});
  const vendor = pkg.provider.name as string;
  if (wi.work_item.state === "APPROVED" && !pkg.vendor_dispute) {
    const clauses = (pkg.clauses as Json[]).map((cl) => cl.ref + " (" + cl.title + ")").join(", ");
    const message =
      "Hello " + vendor + " billing team,\n\n" +
      "We are disputing " + pkg.disputed_amount + " on invoice line " + pkg.invoice_line + ", which billed " + pkg.invoiced + ".\n\n" +
      pkg.reason +
      (clauses ? "\n\nThis follows our agreement, clauses " + clauses + "." : "") +
      "\n\nWe accept the undisputed " + pkg.undisputed_amount + ". Please issue a credit memo for " + pkg.disputed_amount + ".\n\n" +
      "Atlas Research Finance";
    await c.call("send_vendor_dispute", { subject: "Billing dispute: " + pkg.invoice_line + " (" + pkg.disputed_amount + ")", message });
    return;
  }
  const reply = pkg.vendor_dispute as Json | null;
  await c.call("close_dispute", {
    summary:
      reply?.status === "CREDIT_ACCEPTED"
        ? vendor + " credited " + pkg.disputed_amount + " (" + reply.vendor_reference + "). The payable drops by that amount."
        : vendor + " denied the dispute. The disputed " + pkg.disputed_amount + " is charged to the owning project, and the controller can reopen it with the vendor.",
  });
}

const BURN_RANK: Record<string, number> = { on_track: 0, watch: 1, at_risk: 2, over: 3 };

/** Budget Analyst: forecast every team this item charged, and record the one most at risk. */
async function budgetPolicy(c: Caller) {
  const wi = await c.call("get_work_item", {});
  const charges = await c.call("get_posted_charges", {});
  const ids = (charges.project_ids as string[]).length ? (charges.project_ids as string[]) : [wi.work_item.owner_project_id].filter(Boolean);
  let worst: Json | null = null;
  for (const id of ids) {
    const f = await c.call("forecast_project_burn", { project_id: id });
    if (!worst || BURN_RANK[f.status] > BURN_RANK[worst.status]) worst = f;
  }
  if (!worst) throw new Error("No project to check");
  const name = worst.project.name;
  const summary =
    worst.status === "on_track"
      ? name + " is on pace for " + worst.projected_month_end + " of its " + worst.monthly_budget + " budget this month."
      : worst.status === "over"
        ? name + " has spent " + worst.posted_to_date + ", over its " + worst.monthly_budget + " budget."
        : worst.status === "at_risk"
          ? name + " is on pace for " + worst.projected_month_end + " against " + worst.monthly_budget + "; at this rate the budget runs out in " +
            worst.days_of_budget_left + " days, before month end."
          : name + " is on pace for " + worst.projected_month_end + " against " + worst.monthly_budget + ", within 10% of budget.";
  await c.call("record_budget_note", { project_id: worst.project.id, status: worst.status, summary, evidence_ids: c.ids });
}

async function onboardingPolicy(c: Caller) {
  const all = await c.call("query_ap_history", { provider_id: null, months: 6 });
  const stats = all.stats as Json;
  const range = stats.consistent_threshold_range_cents as { from: number; to: number } | null;
  if (!range) {
    await c.call("finish_onboarding", { summary: "History shows no consistent cut-off between variances paid as billed and variances disputed." });
    return;
  }
  // A round number inside the range the history supports, never below what was routinely paid.
  const candidates = [2_500, 5_000, 7_500, 10_000, 25_000, 50_000];
  const threshold = candidates.find((t) => t >= range.from && t <= range.to) ?? range.from;
  const dollars = "$" + (threshold / 100).toFixed(2);
  await c.call("propose_materiality_policy", {
    threshold_cents: threshold,
    statement:
      "GPU invoice lines that exceed the contract-supported charge by " + dollars + " or less are accepted as billed and charged to the owning project. " +
      "Larger variances are investigated and disputed with the vendor.",
    rationale:
      "Across " + stats.lines + " AP lines (" + stats.periods + "), " + stats.paid_as_billed_with_variance + " variances up to " +
      stats.largest_variance_paid_as_billed + " were paid as billed, while all " + stats.disputed + " disputes were for " +
      stats.smallest_variance_disputed + " or more (" + stats.disputes_credited + " credited). Writing the practice down lets small variances post without a dispute that costs more than it recovers.",
    evidence_ids: c.ids,
  });
}

async function followUpPolicy(c: Caller, run: AgentRunContext) {
  const wi = await c.call("get_work_item", {});
  const status = await c.call("get_dispute_status", {});
  const d = status.dispute as Json;
  const clause = (status.dispute_clauses as Json[])[0];
  if (run.trigger.trigger === "dispute_escalation") {
    await c.call("escalate_dispute", {
      summary:
        (status.provider as Json).name + " has not responded to " + d.id + " (" + d.amount + ") after " + d.days_open + " days and " +
        (status.prior_follow_ups as Json[]).length + " follow-up(s). Accounts payable still shows " + status.accounts_payable_outstanding + ".",
      recommended_action:
        "Short-pay the next " + (status.provider as Json).name + " invoice by " + d.amount + " citing " + d.vendor_reference +
        (clause ? ", and confirm with the account manager before the §" + clause.ref + " window closes." : "."),
      evidence_ids: c.ids,
    });
    return;
  }
  await c.call("send_vendor_follow_up", {
    message:
      "Following up on dispute " + d.id + " (your reference " + d.vendor_reference + ") for " + d.amount + " on invoice line " +
      wi.invoice_line.external_line_id + ", submitted " + d.days_open + " days ago with no response. " +
      (clause ? "Under §" + clause.ref + " (" + clause.title + "): \"" + clause.text + "\" " : "") +
      "Please confirm the credit memo or tell us what you need to resolve it.",
    evidence_ids: c.ids,
  });
}

export async function runDeterministicAgent(ctx: AppContext, run: AgentRunContext) {
  const caller = new Caller(ctx, run);
  const trigger = String(run.trigger.trigger ?? "");
  if (run.agentId === ACTOR.policy && trigger === "onboarding") await onboardingPolicy(caller);
  else if (run.agentId === ACTOR.vendorLiaison && (trigger === "dispute_follow_up" || trigger === "dispute_escalation")) await followUpPolicy(caller, run);
  else if (run.agentId === ACTOR.compute || run.agentId === ACTOR.capacity) await computePolicy(caller);
  else if (run.agentId === ACTOR.finance) await financePolicy(caller);
  else if (run.agentId === ACTOR.policy) await policyAnalystPolicy(caller, run);
  else if (run.agentId === ACTOR.vendorLiaison) await vendorPolicy(caller);
  else if (run.agentId === ACTOR.budget) await budgetPolicy(caller);
  else throw new Error("No deterministic policy for " + run.agentId);
}
