"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Network, ShieldCheck, SquareKanban } from "lucide-react";
import { fetcher } from "@/lib/api";
import { money, pct, periodLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardData } from "@/server/queries";
import { useLiveRefresh } from "../live-events";
import { Skeleton } from "../ui/skeleton";
import { Board } from "./board";
import { SystemCanvas } from "./canvas";
import { Caption } from "./caption";
import { ResetButton } from "./reset-button";
import { SimulateDialog } from "./simulate-dialog";

type View = "board" | "canvas";

const VIEWS: { key: View; label: string; icon: typeof Network }[] = [
  { key: "board", label: "Board", icon: SquareKanban },
  { key: "canvas", label: "Canvas", icon: Network },
];

const CLOSE: Record<string, { label: string; dot: string }> = {
  IN_PROGRESS: { label: "Close in progress", dot: "bg-primary" },
  AWAITING_VENDORS: { label: "Awaiting vendors", dot: "bg-primary" },
  READY: { label: "Ready to close", dot: "bg-primary" },
};

function Metrics({ data }: { data: DashboardData }) {
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

export function Dashboard() {
  const [view, setView] = useState<View>("board");
  const [period, setPeriod] = useState<string | null>(null);
  const { data, error, mutate } = useSWR<DashboardData>("/api/dashboard" + (period ? "?period=" + period : ""), fetcher, { keepPreviousData: true });
  useLiveRefresh(() => mutate(), undefined, 250);

  if (error && !data) {
    return <div className="p-8 text-sm text-destructive">Could not load work: {String(error.message)}</div>;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-5">
        <div className="flex rounded-md bg-zinc-100 p-0.5">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={cn(
                "flex items-center gap-1.5 rounded px-2 py-0.5 text-[12px] font-medium",
                view === v.key ? "bg-white text-zinc-900 shadow-xs" : "text-zinc-500 hover:text-zinc-800",
              )}
            >
              <v.icon className="size-3.5" />
              {v.label}
            </button>
          ))}
        </div>
        {data && data.periods.length > 1 ? (
          <select
            value={data.period}
            onChange={(e) => setPeriod(e.target.value)}
            className="h-7 rounded-md bg-transparent px-1 text-[12px] text-muted-foreground outline-none hover:bg-zinc-100"
          >
            {data.periods.map((p) => (
              <option key={p} value={p}>
                {periodLabel(p, true)}
              </option>
            ))}
          </select>
        ) : data ? (
          <span className="text-[12px] text-muted-foreground">{periodLabel(data.period, true)}</span>
        ) : null}
        <Link href="/audit" className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800">
          <ShieldCheck className="size-3.5" />
          Audit trail
        </Link>
        <div className="ml-auto flex items-center gap-4">
          {data ? <Metrics data={data} /> : null}
          <div className="flex items-center gap-1.5">
            <ResetButton onDone={() => mutate()} />
            <SimulateDialog onDone={() => mutate()} />
          </div>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
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
    </div>
  );
}
