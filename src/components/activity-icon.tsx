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
  FINDING: { icon: Search, className: "text-sky-600" },
  HANDOFF: { icon: ArrowRight, className: "text-indigo-600" },
  PROPOSAL: { icon: FilePen, className: "text-violet-600" },
  APPROVAL_REQUEST: { icon: ShieldAlert, className: "text-orange-600" },
  APPROVAL_DECISION: { icon: CircleCheck, className: "text-emerald-600" },
  STATE_CHANGE: { icon: Shuffle, className: "text-zinc-400" },
  POSTING: { icon: BookCheck, className: "text-emerald-600" },
  DISPUTE: { icon: Gavel, className: "text-rose-600" },
  POLICY: { icon: ScrollText, className: "text-indigo-600" },
  ERROR: { icon: TriangleAlert, className: "text-rose-600" },
  DENIED: { icon: Lock, className: "text-rose-600" },
  AGENT_STARTED: { icon: Play, className: "text-blue-600" },
  AGENT_FINISHED: { icon: Flag, className: "text-zinc-400" },
  INGESTION: { icon: Inbox, className: "text-zinc-400" },
  WORK_ITEM: { icon: Inbox, className: "text-blue-600" },
  SYSTEM: { icon: Workflow, className: "text-zinc-400" },
};

export function ActivityIcon({ type, status, className }: { type: string; status?: string; className?: string }) {
  let entry = MAP[type] ?? MAP.SYSTEM;
  if (type === "APPROVAL_DECISION" && status === "error") entry = { icon: CircleX, className: "text-rose-600" };
  const Icon = entry.icon;
  return (
    <span className={cn("grid size-5 shrink-0 place-items-center", entry.className, className)}>
      <Icon className="size-3.5" />
    </span>
  );
}
