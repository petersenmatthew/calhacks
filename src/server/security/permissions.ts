export type Role =
  | "compute_agent"
  | "finance_agent"
  | "capacity_planner"
  | "vendor_liaison"
  | "budget_analyst"
  | "policy_analyst"
  | "controller"
  | "orchestrator"
  | "ingestion"
  | "erp"
  | "ledger_gateway"
  | "vendor_portal"
  | "simulator"
  | "scheduler";

export type Permission =
  | "workitem:read"
  | "compute:read"
  | "contract:read"
  | "findings:compute:write"
  | "handoff:finance"
  | "handoff:compute"
  | "info:request"
  | "budget:read"
  | "policy:read"
  | "precedent:read"
  | "allocation:calculate"
  | "proposal:create"
  | "dispute:propose"
  | "policy:propose"
  | "approval:request"
  | "posting:request"
  | "approval:decide"
  | "workitem:respond"
  | "ledger:post"
  | "dispute:submit"
  | "dispute:read"
  | "dispute:send"
  | "dispute:close"
  | "budget:note"
  | "invoice:ingest"
  | "invoice:record"
  | "vendor:respond"
  | "workflow:orchestrate"
  | "settings:update"
  | "environment:reset"
  | "environment:simulate"
  | "clock:advance"
  | "feed:sync"
  | "followup:create"
  | "dispute:follow_up"
  | "history:read";

/**
 * Role-based permissions. Agents can read evidence and propose; only a human
 * controller can decide approvals, and only the ledger gateway can post.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  compute_agent: ["workitem:read", "compute:read", "contract:read", "findings:compute:write", "handoff:finance", "info:request"],
  finance_agent: [
    "workitem:read",
    "budget:read",
    "policy:read",
    "precedent:read",
    "allocation:calculate",
    "proposal:create",
    "dispute:propose",
    "policy:propose",
    "approval:request",
    "posting:request",
    "handoff:compute",
  ],
  capacity_planner: ["workitem:read", "compute:read", "contract:read", "findings:compute:write", "handoff:finance", "info:request"],
  vendor_liaison: ["workitem:read", "contract:read", "dispute:read", "dispute:send", "dispute:close", "dispute:follow_up"],
  budget_analyst: ["workitem:read", "budget:read", "budget:note"],
  policy_analyst: ["workitem:read", "policy:read", "precedent:read", "policy:propose", "handoff:finance", "history:read"],
  controller: ["workitem:read", "approval:decide", "workitem:respond", "settings:update", "environment:reset", "invoice:ingest", "clock:advance"],
  orchestrator: ["workflow:orchestrate"],
  ingestion: ["invoice:ingest"],
  erp: ["invoice:record"],
  ledger_gateway: ["ledger:post", "dispute:submit"],
  vendor_portal: ["vendor:respond"],
  simulator: ["environment:simulate"],
  scheduler: ["feed:sync", "followup:create", "workflow:orchestrate"],
};

export function roleHas(role: string, permission: Permission) {
  const perms = ROLE_PERMISSIONS[role as Role];
  return Boolean(perms && perms.includes(permission));
}
