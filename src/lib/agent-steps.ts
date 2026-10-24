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
};

export const AGENT_SHORT: Record<string, string> = { "agent.compute": "Compute", "agent.finance": "Finance" };

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
