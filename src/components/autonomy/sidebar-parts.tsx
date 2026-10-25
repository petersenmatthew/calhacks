"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Check, ChevronDown, LoaderCircle, ScrollText, X } from "lucide-react";
import { fetcher, postJson } from "@/lib/api";
import { dateTimeUtc, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AutonomyData } from "@/server/queries";
import { FLOWER_COLORS, Flower } from "../landing/meadow";
import { useLiveRefresh } from "../live-events";

/** Shared fetch for the canvas sidebar: feeds, follow-ups, and the learned policy. */
export function useAutonomy() {
  const swr = useSWR<AutonomyData>("/api/autonomy", fetcher, { keepPreviousData: true, refreshInterval: 15_000 });
  useLiveRefresh(() => swr.mutate(), undefined, 600);
  return swr;
}

export function pendingLearnedPolicy(data: AutonomyData | undefined) {
  const policy = data?.onboarding.policies.at(-1);
  const approval = data?.onboarding.approvals.find((a) => a.status === "PENDING" && a.subjectId === policy?.id);
  return policy && approval ? { policy, approval } : null;
}

/** The policy the Policy Analyst learned from AP history, decided right in the "Needs you" list. */
export function LearnedPolicyRow({ data, refresh }: { data: AutonomyData; refresh: () => void }) {
  const found = pendingLearnedPolicy(data);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  if (!found) return null;
  const { policy, approval } = found;
  const decide = async (decision: "APPROVED" | "REJECTED") => {
    if (decision === "REJECTED" && reason.trim().length < 3) {
      toast.error("Add a reason so the Policy Analyst knows what was wrong.");
      return;
    }
    setBusy(decision);
    try {
      await postJson("/api/approvals/" + approval.id, { decision, reason: reason.trim() || null });
      toast.success(decision === "APPROVED" ? "Policy approved. Small variances now post without a dispute." : "Policy rejected.");
      refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={cn("rounded-lg", open && "bg-zinc-50 ring-1 ring-zinc-200/70")}>
      <button type="button" onClick={() => setOpen(!open)} className="group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left hover:bg-zinc-100/80">
        <span className="grid size-3.5 shrink-0 place-items-center">
          <Flower petal={FLOWER_COLORS[2].petal} eye={FLOWER_COLORS[2].eye} size={10} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-800">Adopt learned policy</span>
        <span className="text-[12px] text-zinc-600 tnum">≤ {money(policy.rule.thresholdCents ?? 0, { cents: false })}</span>
        <ChevronDown className={cn("size-3.5 text-zinc-400 transition-transform", !open && "-rotate-90")} />
      </button>
      {open ? (
        <div className="space-y-2.5 px-2.5 pb-3">
          <div className="flex items-center gap-1.5 text-[11.5px] text-zinc-500">
            <ScrollText className="size-3.5" /> {policy.policyKey} v{policy.version} · learned from AP history by the Policy Analyst
          </div>
          <p className="text-[12.5px] leading-snug text-zinc-800">{policy.statement}</p>
          <p className="text-[12px] leading-snug text-zinc-500">{policy.rationale}</p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (required to reject)"
            rows={1}
            className="w-full resize-none rounded-md bg-white px-2.5 py-1.5 text-[12.5px] ring-1 ring-zinc-200 outline-none focus:ring-zinc-400"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => decide("APPROVED")}
              disabled={busy !== null}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-[12.5px] font-medium text-white hover:bg-zinc-800"
            >
              {busy === "APPROVED" ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Approve
            </button>
            <button
              type="button"
              onClick={() => decide("REJECTED")}
              disabled={busy !== null}
              className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium text-destructive hover:bg-destructive/5"
            >
              {busy === "REJECTED" ? <LoaderCircle className="size-3.5 animate-spin" /> : <X className="size-3.5" />} Reject
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  APPROVAL_REMINDER: "Reminded approver",
  APPROVAL_ESCALATION: "Escalated to CFO",
  DISPUTE_CHASE: "Vendor chase assigned",
  DISPUTE_ESCALATION: "Dispute escalation assigned",
  VENDOR_MESSAGE: "Vendor Liaison messaged vendor",
  ESCALATION_NOTE: "Vendor Liaison escalated dispute",
};

const short = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** What the system is doing without anyone clicking: feed syncs and time-based follow-ups. */
export function RunningOnItsOwn({ data }: { data: AutonomyData }) {
  const [open, setOpen] = useState(true);
  const recent = data.followUps.slice(0, 4);
  return (
    <section className="mt-5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mb-1 flex w-full items-center gap-2 px-2.5 text-[13px] font-medium text-zinc-500 hover:text-zinc-800"
      >
        <Flower petal={FLOWER_COLORS[3].petal} eye={FLOWER_COLORS[3].eye} size={11} className="-mt-0.5" />
        Running on its own
        <ChevronDown className={cn("ml-auto size-3.5 transition-transform", !open && "-rotate-90")} />
      </button>
      {open ? (
        <div className="space-y-0.5">
          {data.scheduler.intervalMs === 0 ? <p className="px-2.5 text-[12px] text-destructive">Scheduler is off (AUTONOMY=off).</p> : null}
          {data.feeds.map((f) => (
            <div key={f.source} className="flex h-8 items-center gap-2.5 px-2.5 text-[12.5px]" title={f.syncedAt ? "Last sync " + dateTimeUtc(f.syncedAt) : "Not synced yet"}>
              <span className="size-[7px] shrink-0 rounded-full bg-zinc-300" />
              <span className="min-w-0 flex-1 truncate text-zinc-700">{f.label}</span>
              <span className="shrink-0 text-[11.5px] text-zinc-400 tnum">
                {f.synced}/{f.total}
                {f.nextAt ? " · next " + short.format(new Date(f.nextAt)) : ""}
              </span>
            </div>
          ))}
          {recent.map((f) => (
            <div key={f.id} className="flex h-8 items-center gap-2.5 px-2.5 text-[12.5px]">
              <span className="size-[7px] shrink-0 rounded-full border-[1.5px] border-zinc-400" />
              <span className="min-w-0 flex-1 truncate text-zinc-700">
                {KIND_LABEL[f.kind] ?? f.kind} <span className="font-mono text-[11px] text-zinc-400">{f.subjectId}</span>
              </span>
              <span className="shrink-0 text-[11.5px] text-zinc-400">{short.format(new Date(f.businessAt))}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
