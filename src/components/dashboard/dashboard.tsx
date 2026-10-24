"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { money, pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardData } from "@/server/queries";
import { useShell } from "../app-shell";
import { useLiveRefresh } from "../live-events";
import { Skeleton } from "../ui/skeleton";
import { Board } from "./board";
import { SystemCanvas } from "./canvas";
import { Caption } from "./caption";

const CLOSE: Record<string, { label: string; dot: string }> = {
  IN_PROGRESS: { label: "Close in progress", dot: "bg-primary" },
  AWAITING_VENDORS: { label: "Awaiting vendors", dot: "bg-primary" },
  READY: { label: "Ready to close", dot: "bg-primary" },
};

export function Metrics({ data }: { data: DashboardData }) {
  const m = data.metrics;
  const close = CLOSE[m.monthClose.status];
  return (
    <div className="hidden items-center gap-4 text-[12px] text-muted-foreground lg:flex">
      <span>
        <span className="font-medium text-zinc-800 tnum">{pct(m.reconciledPct)}</span> reconciled
      </span>
      {m.potentialOverchargeCents > 0 ? (
        <span>
          <span className="font-medium text-destructive tnum">{money(m.potentialOverchargeCents, { cents: false })}</span> overbilled
        </span>
      ) : null}
      <span className="flex items-center gap-1.5">
        <span className={cn("size-1.5 rounded-full", close?.dot)} />
        {close?.label}
      </span>
    </div>
  );
}

/** Shared key so the top bar, the views and the task page reuse one request. */
export function dashboardKey(period: string | null) {
  return "/api/dashboard" + (period ? "?period=" + period : "");
}

export function Dashboard({ view }: { view: "board" | "canvas" }) {
  const { period } = useShell();
  const { data, error, mutate } = useSWR<DashboardData>(dashboardKey(period), fetcher, { keepPreviousData: true });
  useLiveRefresh(() => mutate(), undefined, 250);

  if (error && !data) {
    return <div className="p-8 text-sm text-destructive">Could not load work: {String(error.message)}</div>;
  }

  return (
    <div className="relative h-full min-h-0">
      {!data ? (
        <div className="p-6">
          <Skeleton className="h-64 rounded-lg" />
        </div>
      ) : view === "board" ? (
        <Board data={data} />
      ) : (
        <SystemCanvas data={data} />
      )}
      {data ? <Caption data={data} /> : null}
    </div>
  );
}
