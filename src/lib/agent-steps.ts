/** Short, fixed steps for each agent, derived from the tools a run has called. */

export type StepState = "done" | "active" | "todo";

interface StepDef {
  label: string;
  verb: string;
  tools: string[];
}

export const AGENT_STEPS: Record<string, StepDef[]> = {
  "agent.compute": [
    {
      label: "Gather usage",
      verb: "Gathering usage",
      tools: ["get_work_item", "get_instance_lifecycle", "get_gpu_job_logs", "get_experiment", "get_provider_usage", "find_related_experiments"],
    },
    { label: "Check contract", verb: "Checking contract", tools: ["get_billing_terms"] },
    { label: "Hand off", verb: "Handing off", tools: ["submit_compute_findings", "handoff_to_finance", "request_human_info"] },
  ],
  "agent.finance": [
    { label: "Check policy", verb: "Checking policy", tools: ["get_work_item", "get_project_budget", "get_allocation_policy", "search_precedents"] },
    { label: "Calculate", verb: "Calculating", tools: ["calculate_cost_allocation", "propose_adjustment", "propose_vendor_dispute", "propose_policy"] },
    { label: "Resolve", verb: "Resolving", tools: ["request_human_approval", "submit_for_posting", "request_more_info"] },
  ],
  "agent.capacity": [
    { label: "Reconstruct usage", verb: "Reconstructing usage", tools: ["get_work_item", "find_related_experiments", "get_experiment"] },
    { label: "Check terms", verb: "Checking terms", tools: ["get_billing_terms"] },
    { label: "Hand off", verb: "Handing off", tools: ["submit_compute_findings", "handoff_to_finance", "request_human_info"] },
  ],
  "agent.vendor": [
    { label: "Read dispute", verb: "Reading the dispute", tools: ["get_work_item", "get_dispute_package", "get_billing_terms"] },
    { label: "Contact vendor", verb: "Writing to the vendor", tools: ["send_vendor_dispute", "close_dispute"] },
  ],
  "agent.budget": [
    { label: "Read postings", verb: "Reading postings", tools: ["get_work_item", "get_posted_charges"] },
    { label: "Forecast burn", verb: "Forecasting burn", tools: ["forecast_project_burn"] },
    { label: "Note", verb: "Writing the note", tools: ["record_budget_note"] },
  ],
  "agent.policy": [
    { label: "Read correction", verb: "Reading your correction", tools: ["get_work_item", "get_allocation_policy", "search_precedents"] },
    { label: "Draft policy", verb: "Drafting policy", tools: ["propose_policy"] },
    { label: "Hand back", verb: "Handing back", tools: ["handoff_to_finance"] },
  ],
};

export const AGENT_SHORT: Record<string, string> = {
  "agent.compute": "Auditor",
  "agent.finance": "Allocator",
  "agent.capacity": "Capacity",
  "agent.vendor": "Vendor",
  "agent.budget": "Budget",
  "agent.policy": "Controls",
};

/** Every employee, in the order they sit on the canvas ring. */
export const EMPLOYEE_IDS = ["agent.compute", "agent.finance", "agent.vendor", "agent.budget", "agent.policy", "agent.capacity"] as const;

export function agentSteps(agentId: string, tools: string[], runStatus: "running" | "completed" | "failed" | "none") {
  const defs = AGENT_STEPS[agentId] ?? [];
  let reached = -1;
  tools.forEach((tool) => {
    const i = defs.findIndex((d) => d.tools.includes(tool));
    if (i > reached) reached = i;
  });
  const steps = defs.map((d, i) => {
    let state: StepState = "todo";
    if (runStatus === "completed") state = "done";
    else if (runStatus === "running") state = i < Math.max(reached, 0) ? "done" : i === Math.max(reached, 0) ? "active" : "todo";
    else if (runStatus === "failed") state = i <= reached ? "done" : "todo";
    return { label: d.label, verb: d.verb, state };
  });
  const current = steps.find((s) => s.state === "active") ?? null;
  return { steps, current };
}

/** Kanban column for a work item. */
export type BoardStage = "investigate" | "propose" | "needs_you" | "vendor" | "done";

export const BOARD_STAGES: { key: BoardStage; label: string }[] = [
  { key: "investigate", label: "Investigate" },
  { key: "propose", label: "Propose" },
  { key: "needs_you", label: "Needs you" },
  { key: "vendor", label: "Vendor" },
  { key: "done", label: "Done" },
];

export function boardStage(item: { state: string; assignedAgentId: string | null; pendingApproval?: boolean }): BoardStage {
  if (item.pendingApproval || item.state === "NEEDS_APPROVAL" || item.state === "NEEDS_INFO") return "needs_you";
  if (item.state === "DISPUTED") return "vendor";
  if (item.state === "POSTED" || item.state === "RESOLVED" || item.state === "APPROVED") return "done";
  if (item.state === "PROPOSED" || item.assignedAgentId === "agent.finance") return "propose";
  return "investigate";
}
