import {
  Bot,
  BookCheck,
  Building2,
  Calculator,
  Cpu,
  Database,
  FlaskConical,
  Inbox,
  User,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export const STATE_META: Record<string, { label: string; dot: string }> = {
  NEW: { label: "New", dot: "bg-zinc-400" },
  INVESTIGATING: { label: "Investigating", dot: "bg-blue-500" },
  NEEDS_INFO: { label: "Needs info", dot: "bg-orange-500" },
  PROPOSED: { label: "Proposed", dot: "bg-blue-500" },
  NEEDS_APPROVAL: { label: "Needs approval", dot: "bg-orange-500" },
  APPROVED: { label: "Approved", dot: "bg-blue-500" },
  POSTED: { label: "Posted", dot: "bg-emerald-500" },
  DISPUTED: { label: "Disputed", dot: "bg-rose-500" },
  RESOLVED: { label: "Resolved", dot: "bg-emerald-500" },
};

/** Where an item sits from the controller's point of view. Drives grouping and counts. */
export type StateGroup = "needs_you" | "working" | "vendor" | "done";

export const GROUP_META: Record<StateGroup, { label: string; dot: string }> = {
  needs_you: { label: "Needs you", dot: "bg-orange-500" },
  working: { label: "Agents working", dot: "bg-blue-500" },
  vendor: { label: "Waiting on vendor", dot: "bg-rose-500" },
  done: { label: "Done", dot: "bg-emerald-500" },
};

export function stateGroup(state: string, pendingApproval = false): StateGroup {
  if (pendingApproval || state === "NEEDS_APPROVAL" || state === "NEEDS_INFO") return "needs_you";
  if (state === "DISPUTED") return "vendor";
  if (state === "POSTED" || state === "RESOLVED") return "done";
  return "working";
}

export function StateDot({ state, className }: { state: string; className?: string }) {
  const meta = STATE_META[state] ?? STATE_META.NEW;
  return <span title={meta.label} className={cn("inline-block size-2 shrink-0 rounded-full", meta.dot, state === "INVESTIGATING" && "animate-pulse", className)} />;
}

export function StateBadge({ state, className }: { state: string; className?: string }) {
  const meta = STATE_META[state] ?? STATE_META.NEW;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] whitespace-nowrap text-zinc-700", className)}>
      <StateDot state={state} />
      {meta.label}
    </span>
  );
}

export const PRIORITY_LABEL = ["Urgent", "High", "Medium", "Low"];

const ACTOR_STYLE: Record<string, { icon?: LucideIcon; initials?: string; className: string }> = {
  "agent.compute": { icon: Cpu, className: "bg-sky-600 text-white" },
  "agent.finance": { icon: Calculator, className: "bg-violet-600 text-white" },
  "human.controller": { initials: "PN", className: "bg-amber-500 text-white" },
  "system.orchestrator": { icon: Workflow, className: "bg-zinc-200 text-zinc-700" },
  "system.ingestion": { icon: Inbox, className: "bg-zinc-200 text-zinc-700" },
  "system.erp": { icon: Database, className: "bg-zinc-200 text-zinc-700" },
  "system.ledger_gateway": { icon: BookCheck, className: "bg-zinc-200 text-zinc-700" },
  "system.vendor_portal": { icon: Building2, className: "bg-zinc-200 text-zinc-700" },
  "system.simulator": { icon: FlaskConical, className: "bg-zinc-200 text-zinc-700" },
};

export function AgentAvatar({ actorId, size = "md", className }: { actorId: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const style = ACTOR_STYLE[actorId] ?? { icon: actorId.startsWith("agent") ? Bot : User, className: "bg-zinc-200 text-zinc-700" };
  const Icon = style.icon;
  const dims = size === "sm" ? "size-5 text-[9px]" : size === "lg" ? "size-9 text-xs" : "size-6 text-[10px]";
  const iconDims = size === "sm" ? "size-3" : size === "lg" ? "size-4.5" : "size-3.5";
  return (
    <span className={cn("inline-grid shrink-0 place-items-center rounded-full font-semibold", dims, style.className, className)}>
      {Icon ? <Icon className={iconDims} /> : style.initials}
    </span>
  );
}

const AGENT_STATUS: Record<string, { label: string; dot: string; text: string }> = {
  working: { label: "Working", dot: "animate-pulse bg-blue-500", text: "text-blue-700" },
  queued: { label: "Queued", dot: "bg-amber-500", text: "text-amber-700" },
  idle: { label: "Idle", dot: "bg-zinc-300", text: "text-zinc-500" },
};

export function AgentStatusText({ status, label }: { status: string; label?: string }) {
  const meta = AGENT_STATUS[status] ?? AGENT_STATUS.idle;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11.5px] font-medium whitespace-nowrap", meta.text)}>
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {label ?? meta.label}
    </span>
  );
}

export function modeLabel(mode: string | null | undefined) {
  if (!mode) return null;
  return mode === "llm" ? "LLM" : "Replay";
}
