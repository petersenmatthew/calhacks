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

export const STATE_META: Record<string, { label: string; badge: string; dot: string }> = {
  NEW: { label: "New", badge: "bg-zinc-100 text-zinc-700 ring-zinc-500/15", dot: "bg-zinc-400" },
  INVESTIGATING: { label: "Investigating", badge: "bg-blue-50 text-blue-700 ring-blue-600/15", dot: "bg-blue-500" },
  NEEDS_INFO: { label: "Needs info", badge: "bg-amber-50 text-amber-800 ring-amber-600/20", dot: "bg-amber-500" },
  PROPOSED: { label: "Proposed", badge: "bg-violet-50 text-violet-700 ring-violet-600/15", dot: "bg-violet-500" },
  NEEDS_APPROVAL: { label: "Needs approval", badge: "bg-orange-50 text-orange-700 ring-orange-600/20", dot: "bg-orange-500" },
  APPROVED: { label: "Approved", badge: "bg-teal-50 text-teal-700 ring-teal-600/15", dot: "bg-teal-500" },
  POSTED: { label: "Posted", badge: "bg-emerald-50 text-emerald-700 ring-emerald-600/15", dot: "bg-emerald-500" },
  DISPUTED: { label: "Disputed", badge: "bg-rose-50 text-rose-700 ring-rose-600/15", dot: "bg-rose-500" },
  RESOLVED: { label: "Resolved", badge: "bg-zinc-50 text-zinc-600 ring-zinc-500/15", dot: "bg-emerald-500" },
};

export function StateBadge({ state, className }: { state: string; className?: string }) {
  const meta = STATE_META[state] ?? STATE_META.NEW;
  return (
    <span
      title={state}
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset",
        meta.badge,
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", meta.dot, state === "INVESTIGATING" && "animate-pulse")} />
      {meta.label}
    </span>
  );
}

export const PRIORITY_LABEL = ["Urgent", "High", "Medium", "Low"];

export function PriorityIcon({ priority, className }: { priority: number; className?: string }) {
  if (priority === 0) {
    return (
      <span title="Urgent" className={cn("grid size-4 place-items-center rounded-[4px] bg-rose-500 text-[10px] font-bold text-white", className)}>
        !
      </span>
    );
  }
  const filled = 4 - priority;
  return (
    <span title={PRIORITY_LABEL[priority]} className={cn("inline-block size-4", className)}>
      <svg viewBox="0 0 16 16" className="size-4" aria-label={PRIORITY_LABEL[priority]}>
        {[0, 1, 2].map((i) => (
          <rect
            key={i}
            x={2 + i * 4.5}
            y={10 - i * 3.5}
            width="3"
            height={4 + i * 3.5}
            rx="1"
            className={i < filled ? "fill-zinc-700" : "fill-zinc-300"}
          />
        ))}
      </svg>
    </span>
  );
}

const ACTOR_STYLE: Record<string, { icon?: LucideIcon; initials?: string; className: string }> = {
  "agent.compute": { icon: Cpu, className: "bg-sky-600 text-white" },
  "agent.finance": { icon: Calculator, className: "bg-violet-600 text-white" },
  "human.controller": { initials: "PN", className: "bg-amber-500 text-white" },
  "system.orchestrator": { icon: Workflow, className: "bg-zinc-200 text-zinc-700" },
  "system.ingestion": { icon: Inbox, className: "bg-zinc-200 text-zinc-700" },
  "system.erp": { icon: Database, className: "bg-zinc-200 text-zinc-700" },
  "system.ledger_gateway": { icon: BookCheck, className: "bg-emerald-100 text-emerald-800" },
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

export function AgentStatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    working: "bg-blue-50 text-blue-700 ring-blue-600/15",
    queued: "bg-amber-50 text-amber-800 ring-amber-600/20",
    idle: "bg-zinc-100 text-zinc-600 ring-zinc-500/10",
  };
  const label: Record<string, string> = { working: "Working", queued: "Queued", idle: "Idle" };
  return (
    <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] font-medium ring-1 ring-inset", map[status] ?? map.idle)}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          status === "working" ? "animate-pulse bg-blue-500" : status === "queued" ? "bg-amber-500" : "bg-zinc-400",
        )}
      />
      {label[status] ?? status}
    </span>
  );
}

export function ModeBadge({ mode, className }: { mode: string | null | undefined; className?: string }) {
  if (!mode) return null;
  const llm = mode === "llm";
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-md px-1.5 text-[10.5px] font-medium whitespace-nowrap ring-1 ring-inset",
        llm ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20" : "bg-zinc-100 text-zinc-600 ring-zinc-500/15",
        className,
      )}
      title={llm ? "LLM agent running through the OpenAI Agents SDK" : "Deterministic replay: scripted policy, no LLM calls"}
    >
      {llm ? "LLM" : "Deterministic replay"}
    </span>
  );
}
