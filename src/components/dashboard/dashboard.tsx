"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import type { DashboardData } from "@/server/queries";
import { useShell } from "../app-shell";
import { useLiveRefresh } from "../live-events";
import { Skeleton } from "../ui/skeleton";
import { Board } from "./board";
import { SystemCanvas } from "./canvas";
import { Caption } from "./caption";

/** Shared key so the top bar, the views and the task page reuse one request. */
export function dashboardKey(period: string | null) {
  return "/api/dashboard" + (period ? "?period=" + period : "");
}

export function Dashboard({ view, task = null }: { view: "board" | "canvas"; task?: string | null }) {
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
        <SystemCanvas data={data} initialTask={task} onChanged={() => void mutate()} />
      )}
      {data && view === "board" ? <Caption data={data} /> : null}
    </div>
  );
}
