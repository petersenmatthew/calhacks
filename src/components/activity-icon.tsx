import {
  ArrowRight,
  BookCheck,
  CircleCheck,
  CircleX,
  FilePen,
  Flag,
  Gavel,
  Inbox,
  Lock,
  Play,
  ScrollText,
  Search,
  ShieldAlert,
  Shuffle,
  SquareTerminal,
  TriangleAlert,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const MAP: Record<string, { icon: LucideIcon; className: string }> = {
  TOOL_CALL: { icon: SquareTerminal, className: "text-zinc-400" },
  FINDING: { icon: Search, className: "text-brand-ink" },
  HANDOFF: { icon: ArrowRight, className: "text-brand-ink" },
  PROPOSAL: { icon: FilePen, className: "text-brand-ink" },
  APPROVAL_REQUEST: { icon: ShieldAlert, className: "text-brand-ink" },
  APPROVAL_DECISION: { icon: CircleCheck, className: "text-brand-ink" },
  STATE_CHANGE: { icon: Shuffle, className: "text-zinc-400" },
  POSTING: { icon: BookCheck, className: "text-brand-ink" },
  DISPUTE: { icon: Gavel, className: "text-destructive" },
  POLICY: { icon: ScrollText, className: "text-brand-ink" },
  ERROR: { icon: TriangleAlert, className: "text-destructive" },
  DENIED: { icon: Lock, className: "text-destructive" },
  AGENT_STARTED: { icon: Play, className: "text-brand-ink" },
  AGENT_FINISHED: { icon: Flag, className: "text-zinc-400" },
  INGESTION: { icon: Inbox, className: "text-zinc-400" },
  WORK_ITEM: { icon: Inbox, className: "text-brand-ink" },
  SYSTEM: { icon: Workflow, className: "text-zinc-400" },
};

export function ActivityIcon({ type, status, className }: { type: string; status?: string; className?: string }) {
  let entry = MAP[type] ?? MAP.SYSTEM;
  if (type === "APPROVAL_DECISION" && status === "error") entry = { icon: CircleX, className: "text-destructive" };
  const Icon = entry.icon;
  return (
    <span className={cn("grid size-5 shrink-0 place-items-center", entry.className, className)}>
      <Icon className="size-3.5" />
    </span>
  );
}
