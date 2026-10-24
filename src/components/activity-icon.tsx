import {
  ArrowRight,
  BookCheck,
  CircleCheck,
  CircleX,
  FilePen,
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
  Flag,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const MAP: Record<string, { icon: LucideIcon; className: string }> = {
  TOOL_CALL: { icon: SquareTerminal, className: "bg-zinc-100 text-zinc-600" },
  FINDING: { icon: Search, className: "bg-sky-100 text-sky-700" },
  HANDOFF: { icon: ArrowRight, className: "bg-indigo-100 text-indigo-700" },
  PROPOSAL: { icon: FilePen, className: "bg-violet-100 text-violet-700" },
  APPROVAL_REQUEST: { icon: ShieldAlert, className: "bg-orange-100 text-orange-700" },
  APPROVAL_DECISION: { icon: CircleCheck, className: "bg-emerald-100 text-emerald-700" },
  STATE_CHANGE: { icon: Shuffle, className: "bg-zinc-100 text-zinc-500" },
  POSTING: { icon: BookCheck, className: "bg-emerald-100 text-emerald-700" },
  DISPUTE: { icon: Gavel, className: "bg-rose-100 text-rose-700" },
  POLICY: { icon: ScrollText, className: "bg-indigo-100 text-indigo-700" },
  ERROR: { icon: TriangleAlert, className: "bg-rose-100 text-rose-700" },
  DENIED: { icon: Lock, className: "bg-rose-100 text-rose-700" },
  AGENT_STARTED: { icon: Play, className: "bg-blue-100 text-blue-700" },
  AGENT_FINISHED: { icon: Flag, className: "bg-zinc-100 text-zinc-600" },
  INGESTION: { icon: Inbox, className: "bg-zinc-100 text-zinc-600" },
  WORK_ITEM: { icon: Inbox, className: "bg-blue-100 text-blue-700" },
  SYSTEM: { icon: Workflow, className: "bg-zinc-100 text-zinc-600" },
};

export function ActivityIcon({ type, status, className }: { type: string; status?: string; className?: string }) {
  let entry = MAP[type] ?? MAP.SYSTEM;
  if (type === "APPROVAL_DECISION" && status === "error") entry = { icon: CircleX, className: "bg-rose-100 text-rose-700" };
  const Icon = entry.icon;
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center rounded-full", entry.className, className)}>
      <Icon className="size-3.5" />
    </span>
  );
}
