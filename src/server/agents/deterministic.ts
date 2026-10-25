import { METHOD_LABELS, RESERVATION_METHODS, type AllocationMethod } from "../domain/allocation";
import { formatCents } from "../domain/money";
import { ACTOR } from "../security/actors";
import { amountsIn } from "../workflow/vendor-replies";
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

/**
 * The replay's stand-in for reading the contract: clauses picked by title,
 * each with a stock reason. The live Cost Allocator reads the clause text instead.
 */
function replayClauses(all: { ref: string; title: string }[], anomalies: Json[]) {
  const has = (code: string) => anomalies.some((a) => a.code === code);
  const pick = (word: string, why: string) => all.filter((c) => c.title.toLowerCase().includes(word)).map((c) => ({ ref: c.ref, why }));
  const out = has("DUPLICATE_LINE")
    ? pick("metering", "Each metered hour of the instance can be billed once; these hours were already billed.")
    : [
        ...pick("termination", "Hours were billed after the instance's TERMINATED event."),
        ...pick("metering", "Billable hours are the metered lifetime rounded to the billing increment."),
      ];
  if (has("RATE_MISMATCH")) out.push(...pick("rate", "The line uses a different rate than the contract rate card."));
  return out;
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
  if (mentionsOwner && /(not|instead of|rather than)\s+(by\s+|based on\s+)?usage|not usage[- ]based/.test(text)) return "owner_pays_all";
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
      const terms = await c.call("get_billing_terms", { provider_id: wi.provider.id });
      await c.call("search_precedents", { query: wi.provider.name + " billing after termination dispute credit" });
      const dispute = await c.call("propose_vendor_dispute", {
        rationale:
          "Instance lifecycle and contract terms support " + wi.amounts.contract_supported + " of the " + wi.amounts.invoiced +
          " invoice. The provider billed beyond the TERMINATED event; billing ends at termination under the contract.",
        clauses: replayClauses(terms.clauses, (compute.data?.anomalies ?? []) as Json[]),
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

/** Controls Lead: read the note the controller left with a decision, and propose a rule if it sets one. */
async function guidancePolicy(c: Caller, run: AgentRunContext) {
  const note = String(run.trigger.note ?? "");
  const text = note.toLowerCase();
  // The replay only recognises rules about who pays for GPUs; the live model reads the note itself.
  const aboutCharging = /\bown(s|er|ers|ing)?\b|usage|proportional|reserv|idle/.test(text) && /pay|charge|bill|allocat|split/.test(text);
  if (!aboutCharging) {
    await c.call("finish_guidance", { summary: "Your note is about this case only, so there is no new rule to propose." });
    return;
  }
  const method = interpretCorrection({ reason: note }, "usage_proportional");
  const precedents = await c.call("search_precedents", { query: "shared reservation allocation owner pays controller instruction" });
  const proposed = await c.try("propose_policy", {
    method,
    statement:
      method === "owner_pays_all"
        ? "For shared GPU reservations, the project that owns the reservation pays for all of it, whoever used the GPUs."
        : method === "owner_pays_idle"
          ? "For shared GPU reservations, each project pays for the GPU-hours it used at the reservation rate, and unused reserved capacity is charged to the project that owns the reservation."
          : "For shared GPU reservations, allocate the charge as follows: " + METHOD_LABELS[method] + ".",
    rationale: "From the controller's note when approving on " + run.workItemId + ": " + note,
    precedent_ids: (precedents.matches as Json[]).map((m) => m.id as string),
    evidence_ids: [],
  });
  await c.call("finish_guidance", {
    summary: proposed.ok
      ? "You asked for a standing rule: " + METHOD_LABELS[method] + ". I proposed " + String(proposed.policy_id ?? "it") + " for your approval."
      : "That is already the approved rule (" + METHOD_LABELS[method] + "), so nothing needs to change.",
  });
}

/** Controls Lead: turn a controller correction into a reusable policy, then hand the rework to the Cost Allocator. */
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
    const ev = pkg.evidence_pack as Json | null;
    const grounds = ((ev?.grounds as string[] | undefined) ?? []).join(" ");
    const all = pkg.clauses as Json[];
    const procedural = all.find((cl) => /dispute/i.test(cl.title));
    const clauses = all.filter((cl) => cl !== procedural).map((cl) => "section " + cl.ref + " (" + cl.title + ")").join(" and ");
    const message =
      "Hello " + vendor + " billing team,\n\n" +
      "xAnthropenAI disputes " + pkg.disputed_amount + " of the " + pkg.invoiced + " billed on invoice line " + pkg.invoice_line +
      (ev?.instance ? " for instance " + ev.instance.id : "") + ".\n\n" +
      (grounds || pkg.reason) +
      (clauses ? "\n\nUnder " + clauses + " of our agreement, the supported charge is " + pkg.undisputed_amount + "." : "") +
      (procedural ? " We raise this under section " + procedural.ref + " (" + procedural.title + ")." : "") +
      "\n\nWe will pay the undisputed " + pkg.undisputed_amount + ". Please issue a credit memo for " + pkg.disputed_amount +
      ". The supporting records and the calculation are below and attached.\n\n" +
      "xAnthropenAI Accounts Payable";
    await c.call("send_vendor_dispute", { subject: "Billing dispute: " + pkg.invoice_line + " (" + pkg.disputed_amount + ")", message });
    return;
  }
  const reply = pkg.vendor_dispute as Json | null;
  await c.call("close_dispute", {
    summary:
      reply?.status === "CREDIT_ACCEPTED"
        ? vendor + " credited " + pkg.disputed_amount + " (" + (reply.credit_memo ?? reply.case_reference) + "). The payable drops by that amount."
        : vendor + " denied the dispute. The disputed " + pkg.disputed_amount + " is charged to the owning project, and the controller can reopen it with the vendor.",
  });
}

const DENIAL = /\b(deny|denied|declin\w*|reject\w*|cannot (?:issue|approve|credit)|unable to (?:issue|approve|credit)|(?:charges?|invoice) (?:stands|is valid|was valid|is correct)|upheld|not eligible)\b/i;
const CREDIT = /\b(credit(?:ed)?|credit memo|refund(?:ed)?)\b/i;
const CREDIT_DONE = /\b(issued|applied|approved|processed|accept(?:ed)?|will issue|have issued|granted)\b/i;
const ASK = /\?|\b(please (?:send|provide|share|confirm)|could you|can you|we need|need (?:the|a|your|more)|require)\b/i;
const STAFF_ONLY = /\b(PO|purchase order|signature|sign|W-?9|tax id|bank|remittance|contact person|account manager)\b/i;

/** Vendor Liaison: the provider wrote back. Book a decision, answer a question, or take an offer to the controller. */
async function vendorReplyPolicy(c: Caller, run: AgentRunContext) {
  await c.call("get_work_item", {});
  const t = await c.call("get_vendor_thread", {});
  const d = t.dispute as Json;
  const disputed = amountsIn(String(d.disputed_amount))[0];
  const waiting = t.waiting_for_you as Json[];
  const vendor = (t.provider as Json).name as string;
  const ev = t.evidence_you_can_share as Json | null;
  const grounds = ((ev?.grounds as string[] | undefined) ?? []).join(" ");
  if (run.trigger.trigger === "human_info") {
    const answer = String(((t.controller_answers as Json[])[0] ?? {}).answer ?? "");
    const offer = waiting.find((w) => w.status === "waiting_on_controller") ?? waiting[waiting.length - 1];
    if (!offer) throw new Error("No vendor message is waiting on the controller's answer");
    const offered = amountsIn(String(offer.body)).filter((a) => a !== disputed && a < disputed);
    const declined = /\b(no|reject|decline|don'?t|do not|refuse|hold out|push back)\b/i.test(answer);
    if (!declined && offered.length) {
      const amount = offered[0];
      await c.call("record_vendor_decision", {
        message_id: offer.id,
        decision: "partial_credit",
        credit_reference: null,
        credit_amount_cents: amount,
        confirmation_message:
          "Thank you. xAnthropenAI accepts your credit of " + formatCents(amount) + " to settle dispute " + d.id + ". Please send the credit memo for our records.",
        summary: vendor + " offered " + formatCents(amount) + " of the " + d.disputed_amount + "; the controller accepted it. The rest is charged to the owning project.",
      });
      return;
    }
    await c.call("reply_to_vendor", {
      answering: [offer.id],
      message:
        "Thank you for your reply. After review, xAnthropenAI maintains its dispute of the full " + d.disputed_amount + ". " +
        (grounds || String(d.reason)) + " Please issue a credit memo for " + d.disputed_amount + ".",
      attach_evidence: true,
      kind: offered.length ? "counter_offer" : "question",
    });
    return;
  }
  const msg = waiting[waiting.length - 1];
  if (!msg) throw new Error("No vendor message is waiting");
  const body = String(msg.body);
  const others = amountsIn(body).filter((a) => a !== disputed);
  const mentionsDisputed = amountsIn(body).includes(disputed);
  if (DENIAL.test(body) && !CREDIT_DONE.test(body.replace(DENIAL, ""))) {
    await c.call("record_vendor_decision", {
      message_id: msg.id,
      decision: "denied",
      credit_reference: null,
      credit_amount_cents: null,
      confirmation_message: null,
      summary: vendor + " refused the credit: \u201c" + body.replace(/\s+/g, " ").slice(0, 200) + "\u201d The disputed " + d.disputed_amount + " is charged to the owning project; the controller can reopen it.",
    });
    return;
  }
  if (others.length && !mentionsDisputed) {
    await c.call("ask_controller", {
      message_id: msg.id,
      question: vendor + " offered " + others.map(formatCents).join(" / ") + " instead of the disputed " + d.disputed_amount + " on " + d.id + ". Accept it?",
      recommendation:
        others[0] >= disputed * 0.75
          ? "Accept: it recovers most of the overcharge and closes the case now."
          : "Decline and hold out for the full amount: the evidence shows the whole " + d.disputed_amount + " was billed after termination.",
      kind: "counter_offer",
    });
    return;
  }
  if (CREDIT.test(body) && CREDIT_DONE.test(body)) {
    await c.call("record_vendor_decision", {
      message_id: msg.id,
      decision: "credited",
      credit_reference: body.match(/\b(?:CM|CR|CN)[-\s#]?\d{2,}\b/i)?.[0] ?? null,
      credit_amount_cents: null,
      confirmation_message: "Thank you for issuing the credit of " + d.disputed_amount + ". We have applied it" + ((ev?.invoice as Json | undefined)?.lineId ? " against invoice line " + (ev?.invoice as Json).lineId : "") + " and closed dispute " + d.id + ".",
      summary: vendor + " credited the full " + d.disputed_amount + ". The payable drops by that amount.",
    });
    return;
  }
  if (ASK.test(body)) {
    if (STAFF_ONLY.test(body)) {
      await c.call("ask_controller", {
        message_id: msg.id,
        question: vendor + " asks: \u201c" + body.replace(/\s+/g, " ").slice(0, 300) + "\u201d I don't have this in the systems of record. What should I send?",
        recommendation: "Reply with the requested detail so the credit is not held up.",
        kind: "question",
      });
      return;
    }
    const calc = (ev?.calculation as string[] | undefined) ?? [];
    await c.call("reply_to_vendor", {
      answering: [msg.id],
      message:
        "Thanks for looking into this. Here is what you asked for. " + (grounds || String(d.reason)) +
        (calc.length ? " Calculation: " + calc.join(" ") : "") +
        " The full records (instance lifecycle with your termination acknowledgment, usage, and the calculation) are attached as CSV. Please issue a credit memo for " + d.disputed_amount + ".",
      attach_evidence: true,
      kind: "question",
    });
    return;
  }
  await c.call("note_vendor_update", { message_id: msg.id, summary: vendor + " acknowledged " + d.id + " and has not decided yet." });
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

/** Budget Analyst on the controller's instruction: apply exactly the budget they approved. */
async function budgetChangePolicy(c: Caller, run: AgentRunContext) {
  const t = run.trigger;
  await c.call("get_work_item", {});
  const before = await c.call("forecast_project_burn", { project_id: t.projectId });
  await c.call("set_project_budget", {
    project_id: t.projectId,
    monthly_budget_cents: t.monthlyCents,
    summary: before.project.name + " has " + before.posted_to_date + " posted this month and is on pace for " + before.projected_month_end + ".",
  });
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
  else if (run.agentId === ACTOR.vendorLiaison && (trigger === "vendor_message" || trigger === "human_info")) await vendorReplyPolicy(caller, run);
  else if (run.agentId === ACTOR.compute || run.agentId === ACTOR.capacity) await computePolicy(caller);
  else if (run.agentId === ACTOR.finance) await financePolicy(caller);
  else if (run.agentId === ACTOR.policy && trigger === "controller_guidance") await guidancePolicy(caller, run);
  else if (run.agentId === ACTOR.policy) await policyAnalystPolicy(caller, run);
  else if (run.agentId === ACTOR.vendorLiaison) await vendorPolicy(caller);
  else if (run.agentId === ACTOR.budget && trigger === "controller_note") await budgetChangePolicy(caller, run);
  else if (run.agentId === ACTOR.budget) await budgetPolicy(caller);
  else throw new Error("No deterministic policy for " + run.agentId);
}
