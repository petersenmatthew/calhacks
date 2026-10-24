/**
 * The outside systems an employee can reach, derived from its tools:
 * systems of record it reads or posts to, plus email and Slack.
 */
import { PROVIDER_SOURCE, SOURCE, type SourceId } from "./sources";

export type ConnectionId = SourceId | "email" | "slack";
type Access = "read" | "write";

export type Connection = {
  id: ConnectionId;
  name: string;
  kind: string;
  logo: string | null;
  read: boolean;
  write: boolean;
  /** Calls this employee made that touched the system. */
  uses: number;
  lastAt: string | null;
  tools: string[];
};

const PROVIDERS: SourceId[] = ["lambda", "coreweave", "nebius"];

/** Which systems each tool touches, and how. */
const TOOL_LINKS: Record<string, [ConnectionId | "providers", Access][]> = {
  get_work_item: [["providers", "read"]],
  get_provider_usage: [["providers", "read"]],
  get_instance_lifecycle: [["kubernetes", "read"]],
  get_gpu_job_logs: [["kubernetes", "read"]],
  find_related_experiments: [["kubernetes", "read"]],
  get_experiment: [["wandb", "read"]],
  get_billing_terms: [["ironclad", "read"]],
  get_project_budget: [["netsuite", "read"]],
  get_posted_charges: [["netsuite", "read"]],
  forecast_project_burn: [["netsuite", "read"]],
  query_ap_history: [["netsuite", "read"]],
  submit_for_posting: [["netsuite", "write"]],
  record_vendor_decision: [["netsuite", "write"]],
  close_dispute: [["netsuite", "write"]],
  send_vendor_dispute: [["email", "write"]],
  send_vendor_follow_up: [["email", "write"], ["slack", "write"]],
  reply_to_vendor: [["email", "write"]],
  get_vendor_thread: [["email", "read"]],
  request_human_info: [["slack", "write"]],
  request_human_approval: [["slack", "write"]],
  ask_controller: [["slack", "write"]],
  escalate_dispute: [["slack", "write"]],
  record_budget_note: [["slack", "write"]],
};

const EXTRA: Record<"email" | "slack", { name: string; kind: string }> = {
  email: { name: "Email", kind: "Vendor billing inboxes" },
  slack: { name: "Slack", kind: "#finance-ops and DMs to you" },
};

/** usage: this employee's calls per tool and per task provider. */
export function connectionsFor(tools: string[], usage: { tool: string; provider: string | null; n: number; last: string }[]): Connection[] {
  const out = new Map<ConnectionId, Connection>();
  for (const tool of tools) {
    for (const [target, access] of TOOL_LINKS[tool] ?? []) {
      for (const id of target === "providers" ? PROVIDERS : [target]) {
        const base = id === "email" || id === "slack" ? { ...EXTRA[id], logo: null } : { name: SOURCE[id].name, kind: SOURCE[id].kind, logo: SOURCE[id].logo };
        const c = out.get(id) ?? { id, ...base, read: false, write: false, uses: 0, lastAt: null, tools: [] };
        c[access] = true;
        if (!c.tools.includes(tool)) {
          c.tools.push(tool);
          // A provider tool touches whichever cloud the task is on, so only those calls count for this cloud.
          for (const u of usage.filter((x) => x.tool === tool && (target !== "providers" || (x.provider && PROVIDER_SOURCE[x.provider] === id)))) {
            c.uses += u.n;
            c.lastAt = !c.lastAt || u.last > c.lastAt ? u.last : c.lastAt;
          }
        }
        out.set(id, c);
      }
    }
  }
  return [...out.values()].sort((a, b) => Number(b.uses > 0) - Number(a.uses > 0) || b.uses - a.uses);
}
