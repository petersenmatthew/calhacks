/**
 * Turns a task's activity log into what the employees would say to the
 * controller while they work: one short first-person line per tool call,
 * built only from that call's stored arguments and results.
 */
import { dateTimeUtc, hours } from "./format";
import type { ActivityRow, WorkspaceData } from "@/server/queries";

export type FeedLine =
  | { kind: "agent"; id: number; actorId: string; at: string; text: string; tone?: "warn" | "bad"; tool?: string }
  | { kind: "you"; id: number; at: string; text: string }
  | { kind: "event"; id: number; at: string; text: string; tone?: "bad" };

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
const dollars = (v: string) => Number(v.replace(/[$,]/g, "")) || 0;
const cap = (t: string, max = 260) => (t.length > max ? t.slice(0, max - 1).trimEnd() + "..." : t);

function say(row: ActivityRow, w: WorkspaceData): string {
  const a = row.args;
  const r = row.result;
  const provider = w.providers[w.item.providerId]?.name ?? "The provider";
  switch (row.toolName) {
    case "get_work_item": {
      const flags = list(r, "deterministic_checks.flags").length;
      return (
        "Opening " + w.item.id + ": " + s(r, "invoice_line.description") + ". Billed " + s(r, "amounts.invoiced") + "; the contract supports " + s(r, "amounts.contract_supported") + "." +
        (flags ? " " + flags + " intake check" + (flags > 1 ? "s" : "") + " flagged it." : "")
      );
    }
    case "get_instance_lifecycle":
      return s(r, "terminated_at")
        ? "Cluster events show " + s(a, "instance_id") + " was up " + hours(n(r, "lifecycle_hours")) + ", from " + dateTimeUtc(s(r, "provisioned_at")) + " until it was terminated " + dateTimeUtc(s(r, "terminated_at")) + "."
        : "There's no termination event for " + s(a, "instance_id") + ". So far it has been up " + hours(n(r, "lifecycle_hours")) + ".";
    case "get_gpu_job_logs":
      return "Job " + s(a, "job_id") + " ran " + hours(n(r, "wall_clock_hours")) + " on " + n(r, "job.gpus") + " GPUs and ended " + s(r, "job.status").toLowerCase() + ".";
    case "get_experiment":
      return "It belongs to " + s(r, "experiment.name") + ", owned by " + s(r, "experiment.owner") + " on " + s(r, "project.name") + ".";
    case "get_provider_usage": {
      const c = w.item.checks;
      const over = c.kind === "instance" && c.terminatedAt ? n(r, "total_hours") - c.lifecycleHours : 0;
      return provider + "'s meter says " + hours(n(r, "total_hours")) + "." + (over > 0.5 ? " That's " + hours(over) + " more than the instance was up." : "");
    }
    case "get_billing_terms": {
      const unsupported = s(r, "computed.amount_not_supported_by_contract");
      return (
        "The contract allows " + hours(n(r, "computed.contract_billable_hours")) + " at " + s(r, "computed.contract_rate_per_hour") + "/h. " +
        (unsupported && unsupported !== "$0.00" ? unsupported + " of the charge isn't supported by it." : "The charge is within the contract.")
      );
    }
    case "find_related_experiments": {
      const parts = list(r, "usage_by_project").map((u) => s(u, "project_name") + " used " + n(u, "gpu_hours").toLocaleString("en-US") + " GPU-h");
      return "On " + s(a, "reservation_id") + ", " + parts.join(", ") + ", and " + n(r, "idle_gpu_hours").toLocaleString("en-US") + " GPU-h sat idle.";
    }
    case "submit_compute_findings":
      return s(a, "summary");
    case "handoff_to_finance":
      return "Handing this to the Cost Allocator. " + cap(s(a, "note"), 200);
    case "request_human_info":
      return "I need you on this one: " + s(a, "question");
    case "request_more_info":
      return "Asking the GPU Auditor: " + s(a, "question");
    case "get_project_budget":
      return s(r, "project.name") + " has posted " + s(r, "posted_to_date") + " of its " + s(r, "monthly_budget") + " budget.";
    case "get_allocation_policy":
      return s(r, "applicable_policy.id")
        ? "Policy " + s(r, "applicable_policy.id") + " applies" + (s(r, "applicable_policy.auto_post_limit") ? ", so charges like this can post up to " + s(r, "applicable_policy.auto_post_limit") + " without you." : ".")
        : "No standing policy covers this.";
    case "search_precedents": {
      const m = list(r, "matches");
      return m.length ? "I found " + m.length + " similar past decision" + (m.length > 1 ? "s" : "") + ". Closest: " + s(m[0], "title") + "." : "No past decisions match this.";
    }
    case "calculate_cost_allocation": {
      const lines = list(r, "lines").map((l) => s(l, "project_name") + " " + s(l, "amount"));
      return "By " + (s(r, "method_label") || "usage").toLowerCase() + ", that's " + lines.join(" and ") + ".";
    }
    case "propose_adjustment":
      return get(r, "standing_authorization.authorized")
        ? "A standing policy covers this split, so I can post it without you."
        : "This split needs your approval. " + cap(s(a, "rationale"), 200);
    case "propose_vendor_dispute":
      return "I'm proposing we pay " + s(r, "undisputed_amount") + " and dispute " + s(r, "disputed_amount") + " with " + provider + ".";
    case "propose_policy":
      return "I drafted a rule from your past decisions: " + cap(s(a, "statement"), 200);
    case "request_human_approval":
      return "Sent to you for approval.";
    case "submit_for_posting":
      return get(r, "posted") ? "Posted " + s(r, "journal_entry_id") + " to the ledger." : "Submitted for posting.";
    case "get_dispute_package":
      return "Pulling the approved dispute file: " + s(r, "disputed_amount") + " against " + s(r, "provider.name") + ".";
    case "send_vendor_dispute":
      return "Sent the dispute letter to " + s(r, "provider") + ". Now waiting on their reply.";
    case "close_dispute":
      return s(r, "outcome") === "VENDOR_CREDIT"
        ? provider + " credited " + s(r, "amount") + ". I reduced the payable and closed the case."
        : provider + " denied it, so I charged " + s(r, "amount") + " to the owning project and closed the case.";
    case "get_posted_charges": {
      const c = list(r, "charges");
      return c.length ? "Charges posted for this task: " + c.map((x) => s(x, "project_name") + " " + s(x, "amount")).join(", ") + "." : "Nothing has posted for this task yet.";
    }
    case "forecast_project_burn":
      return (
        s(r, "project.name") + " is on pace for " + s(r, "projected_month_end") + " of " + s(r, "monthly_budget") + " (" + s(r, "status").replace(/_/g, " ") + ")." +
        (dollars(s(r, "projected_month_end")) > dollars(s(r, "monthly_budget")) ? " That's over budget." : "")
      );
    case "record_budget_note":
      return cap(s(a, "summary") || row.summary || row.title);
    case "set_project_budget": {
      const name = w.projects[s(r, "project_id")]?.name ?? "the project";
      const whole = (v: string) => v.replace(/\.00$/, "");
      const down = dollars(s(r, "monthly_budget")) < dollars(s(r, "previous_budget"));
      return "Done: the " + name + " budget is now " + whole(s(r, "monthly_budget")) + " a month, " + (down ? "down" : "up") + " from " + whole(s(r, "previous_budget")) + ", as you asked.";
    }
    default:
      return row.summary ? cap(row.summary) : row.title;
  }
}

export function buildFeed(w: WorkspaceData): FeedLine[] {
  const out: FeedLine[] = [];
  let opened = false;
  for (const row of w.activity) {
    if (row.actorId.startsWith("human.")) {
      const name = w.actors[row.actorId]?.name ?? "";
      const said = name && row.title.startsWith(name) ? "You" + row.title.slice(name.length) : row.title;
      // Keep the controller's own words with the decision, so a note left with an approval is not lost.
      out.push({ kind: "you", id: row.id, at: row.createdAt, text: row.summary ? said + ": \u201c" + row.summary.trim() + "\u201d" : said });
      continue;
    }
    const agent = row.actorId.startsWith("agent.");
    if (row.type === "WORK_ITEM") {
      out.push({ kind: "event", id: row.id, at: row.createdAt, text: row.title });
    } else if (agent && row.type === "AGENT_STARTED") {
      out.push({ kind: "event", id: row.id, at: row.createdAt, text: (w.actors[row.actorId]?.name ?? row.actorId) + " picked this up" });
    } else if (agent && (row.status === "denied" || row.status === "error")) {
      const why = (row.summary ?? row.title).replace(/\s*\[[A-Z_]+\]\s*/g, " ").trim().replace(/\.?$/, ".");
      out.push({ kind: "agent", id: row.id, actorId: row.actorId, at: row.createdAt, text: "That didn't go through. " + cap(why, 180) + " Trying again.", tone: "bad" });
    } else if (agent && row.toolName) {
      const text = row.toolName === "get_work_item" && opened ? "Catching up on the task and what the team found so far." : say(row, w);
      if (row.toolName === "get_work_item") opened = true;
      out.push({ kind: "agent", id: row.id, actorId: row.actorId, at: row.createdAt, text, tool: row.toolName });
    } else if (row.type === "DISPUTE" || row.type === "POLICY") {
      out.push({ kind: "event", id: row.id, at: row.createdAt, text: row.title });
    }
  }
  return out;
}
