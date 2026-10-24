"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

/*
 * Temporary: compares three review layouts on the same task. Remove the
 * losers and this switcher once one is picked.
 */
const OPTIONS = [
  { key: "sidebar", letter: "A", label: "Sidebar", href: (id: string) => "/canvas?task=" + id },
  { key: "focus", letter: "B", label: "Focus", href: (id: string) => "/investigations/" + id },
  { key: "proof", letter: "C", label: "Proof", href: (id: string) => "/investigations/" + id + "?v=proof" },
] as const;

export type ReviewLayout = (typeof OPTIONS)[number]["key"];

export function ReviewSwitcher({ taskId, current, className }: { taskId: string; current: ReviewLayout; className?: string }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className={cn("flex items-center gap-0.5 rounded-xl bg-white/90 p-1 shadow-[0_1px_2px_rgb(0_0_0/0.05),0_4px_14px_rgb(0_0_0/0.06)] ring-1 ring-zinc-200 backdrop-blur", className)}
    >
      <span className="px-2 text-[11px] text-zinc-400">Prototype</span>
      {OPTIONS.map((o) => (
        <Link
          key={o.key}
          href={o.href(taskId)}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-colors",
            current === o.key ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
          )}
        >
          <span className={cn("font-mono text-[10.5px]", current === o.key ? "text-white/60" : "text-zinc-400")}>{o.letter}</span>
          {o.label}
        </Link>
      ))}
    </div>
  );
}

