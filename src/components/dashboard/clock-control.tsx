"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Clock, LoaderCircle } from "lucide-react";
import { postJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";

const STEPS = [
  { hours: 1, label: "+1 hour", hint: "Next feed lines publish" },
  { hours: 24, label: "+1 day", hint: "Approval reminders fire" },
  { hours: 24 * 3, label: "+3 days", hint: "Waiting approvals escalate to the CFO" },
  { hours: 24 * 15, label: "+15 days", hint: "Agent chases unanswered vendor disputes" },
  { hours: 24 * 16, label: "+16 days", hint: "Agent escalates disputes still unanswered" },
];

const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

/** Business clock. Finance runs over weeks; the demo can move time forward to show what happens. */
export function ClockControl({ now, offsetMs, onDone }: { now: string; offsetMs: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const advance = async (hours: number, label: string) => {
    setBusy(true);
    try {
      await postJson("/api/clock", { hours });
      toast.success("Business clock moved " + label.replace("+", "") + " forward");
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] outline-none hover:bg-zinc-100",
          offsetMs > 0 ? "text-brand-ink" : "text-muted-foreground",
        )}
        title="Business clock (UTC). Syncs and follow-ups run against it."
      >
        {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Clock className="size-3.5" />}
        <span className="tnum">{fmt.format(new Date(now))}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-xs">Move time forward (demo)</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {STEPS.map((s) => (
          <DropdownMenuItem key={s.hours} onSelect={() => advance(s.hours, s.label)} disabled={busy} className="flex-col items-start gap-0.5">
            <span className="text-[13px] font-medium">{s.label}</span>
            <span className="text-[11px] text-muted-foreground">{s.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
