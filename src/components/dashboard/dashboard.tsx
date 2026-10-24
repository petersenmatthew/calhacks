"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { Bot, CalendarCheck, CircleDollarSign, FileWarning, Gauge, ListChecks, ShieldAlert, TriangleAlert } from "lucide-react";
import { fetcher } from "@/lib/api";
import { compactMoney, dateOnly, money, pct, periodLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardData } from "@/server/queries";
import { useLiveRefresh } from "../live-events";
import { Skeleton } from "../ui/skeleton";
import { ActivityFeed } from "./activity-feed";
import { MetricCard } from "./metric-card";
import { ResetButton } from "./reset-button";
import { SimulateDialog } from "./simulate-dialog";
import { WorkQueue } from "./work-queue";

const CLOSE_LABEL: Record<string, { label: string; dot: string }> = {
  IN_PROGRESS: { label: "In progress", dot: "bg-amber-500" },
  AWAITING_VENDORS: { label: "Awaiting vendors", dot: "bg-blue-500" },
  READY: { label: "Ready to close", dot: "bg-emerald-500" },
};

export function Dashboard() {
  const [period, setPeriod] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const seen = useRef<Map<string, string> | null>(null);
  const { data, error, mutate } = useSWR<DashboardData>("/api/dashboard" + (period ? "?period=" + period : ""), fetcher, {
    keepPreviousData: true,
    onSuccess: (next) => {
      const previous = seen.current;
      const changed = new Set<string>();
      if (previous) {
        for (const item of next.workItems) {
          if (previous.get(item.id) !== item.updatedAt) changed.add(item.id);
        }
      }
      seen.current = new Map(next.workItems.map((i) => [i.id, i.updatedAt]));
      setFresh(changed);
    },
  });
  useLiveRefresh(() => mutate(), undefined, 250);

  if (error && !data) {
    return <div className="p-8 text-sm text-rose-600">Could not load the dashboard: {String(error.message)}</div>;
  }

  const m = data?.metrics;
  const close = m ? CLOSE_LABEL[m.monthClose.status] : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1440px] space-y-5 px-6 py-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-[19px] font-semibold tracking-tight">Operations</h1>
              {data && data.periods.length > 1 ? (
                <div className="flex rounded-lg bg-zinc-100 p-0.5">
                  {data.periods
                    .slice()
                    .reverse()
                    .map((p) => (
                      <button
                        key={p}
                        onClick={() => setPeriod(p)}
                        className={cn(
                          "rounded-md px-2 py-0.5 text-[12px] font-medium",
                          data.period === p ? "bg-white text-zinc-900 shadow-xs" : "text-zinc-500 hover:text-zinc-800",
                        )}
                      >
                        {periodLabel(p, true)}
                      </button>
                    ))}
                </div>
              ) : null}
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {data ? periodLabel(data.period) + " close" : "Loading"} · An autonomous finance team reconciles Atlas Research GPU spend, disputes
              overcharges, and asks you when a decision needs a human.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ResetButton onDone={() => mutate()} />
            <SimulateDialog onDone={() => mutate()} />
          </div>
        </div>

        {!data || !m ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 2xl:grid-cols-8">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-[104px] rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 2xl:grid-cols-8">
            <MetricCard
              icon={<CircleDollarSign className="size-3.5" />}
              label="Compute spend"
              value={compactMoney(m.totalSpendCents)}
              sub={m.lineCount + " invoice lines · " + money(m.totalSpendCents, { cents: false })}
            />
            <MetricCard icon={<Gauge className="size-3.5" />} label="Reconciled" value={pct(m.reconciledPct)} sub={money(m.reconciledCents, { cents: false }) + " matched and posted"}>
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                <div className="h-full rounded-full bg-emerald-500 transition-all duration-700" style={{ width: pct(m.reconciledPct) }} />
              </div>
            </MetricCard>
            <MetricCard
              icon={<FileWarning className="size-3.5" />}
              label="Open discrepancies"
              value={m.unresolvedCount}
              sub={money(m.unresolvedAmountCents, { cents: false }) + " under investigation"}
            />
            <MetricCard
              icon={<TriangleAlert className="size-3.5" />}
              label="Vendor overcharges"
              value={money(m.potentialOverchargeCents, { cents: false })}
              tone={m.potentialOverchargeCents > 0 ? "danger" : "default"}
              sub={"Potential · " + m.potentialOverchargeCount + " line(s) billed beyond contract"}
            />
            <MetricCard
              icon={<ShieldAlert className="size-3.5" />}
              label="Pending approvals"
              value={m.pendingApprovals}
              tone={m.pendingApprovals > 0 ? "warning" : "default"}
              sub="Controller decisions"
            />
            <MetricCard
              icon={<ListChecks className="size-3.5" />}
              label="Reconciliations"
              value={m.completedReconciliations + " / " + m.lineCount}
              sub={"Completed · " + m.autoMatched + " auto-matched by policy"}
            />
            <MetricCard
              icon={<Bot className="size-3.5" />}
              label="Agent activity"
              value={m.agentToolCalls + " tool calls"}
              sub={
                m.agentRuns +
                " agent runs · " +
                (m.agentLlmRuns ? m.agentLlmRuns + " LLM, " + (m.agentRuns - m.agentLlmRuns) + " deterministic" : "deterministic replay")
              }
            />
            <MetricCard
              icon={<CalendarCheck className="size-3.5" />}
              label="Month close"
              value={
                <span className="flex items-center gap-2 text-[15px] whitespace-nowrap">
                  <span className={cn("size-2 rounded-full", close?.dot)} />
                  {close?.label}
                </span>
              }
              sub={
                (m.monthClose.blockers ? m.monthClose.blockers + " blocker(s)" : "No blockers") +
                (m.monthClose.disputesOpen ? " · " + m.monthClose.disputesOpen + " dispute(s) open" : "") +
                " · target " +
                dateOnly(m.monthClose.target)
              }
            />
          </div>
        )}

        <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_360px]">
          {data ? <WorkQueue data={data} fresh={fresh} /> : <Skeleton className="h-[420px] rounded-xl" />}
          <div className="flex max-h-[460px] flex-col 2xl:sticky 2xl:top-0 2xl:max-h-[calc(100dvh-140px)]">
            {data ? <ActivityFeed data={data} /> : <Skeleton className="h-[420px] rounded-xl" />}
          </div>
        </div>
      </div>
    </div>
  );
}
