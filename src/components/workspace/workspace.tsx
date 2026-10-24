"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { ChevronRight, ScrollText, Workflow } from "lucide-react";
import { fetcher } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { WorkspaceData } from "@/server/queries";
import { useLiveRefresh } from "../live-events";
import { AgentStatusText, StateBadge } from "../status";
import { Skeleton } from "../ui/skeleton";
import { ActivityTimeline } from "./activity-timeline";
import { DecisionPanel } from "./decision-panel";
import { DetailsPanel } from "./details-panel";
import { EvidenceDialog } from "./evidence-dialog";
import { FlowView } from "./flow-view";
import { WorkspaceContext } from "./workspace-context";

function WorkingNow({ data }: { data: WorkspaceData }) {
  const here = data.agents.filter((a) => a.currentWorkItemId === data.item.id && a.status !== "idle");
  if (!here.length) return null;
  return (
    <div className="flex items-center gap-3">
      {here.map((a) => (
        <AgentStatusText
          key={a.agentId}
          status={a.status}
          label={(data.actors[a.agentId]?.name ?? a.agentId) + (a.status === "working" ? " working" : " queued")}
        />
      ))}
    </div>
  );
}

export function Workspace({ id }: { id: string }) {
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [tab, setTab] = useState<"flow" | "log">("flow");
  const { data, error, mutate } = useSWR<WorkspaceData>("/api/work-items/" + id, fetcher, { keepPreviousData: true });
  useLiveRefresh(() => mutate(), (event) => event.workItemId === id || event.workItemId === null, 150);
  const ctx = useMemo(() => (data ? { data, openEvidence: setEvidenceId, refresh: () => void mutate() } : null), [data, mutate]);

  if (error && !data) {
    return (
      <div className="p-8 text-[13px]">
        <div className="font-medium">Could not open {id}</div>
        <div className="mt-1 text-muted-foreground">{String(error.message)}</div>
        <Link href="/" className="mt-3 inline-block text-brand-ink hover:underline">
          Back to work
        </Link>
      </div>
    );
  }
  if (!data || !ctx) {
    return (
      <div className="grid h-full grid-cols-1 gap-4 p-6 xl:grid-cols-[1fr_360px]">
        <Skeleton className="h-full rounded-lg" />
        <Skeleton className="h-full rounded-lg" />
      </div>
    );
  }
  const item = data.item;
  const reworked = data.transitions.some((t) => t.fromState === "NEEDS_APPROVAL" && t.toState === "INVESTIGATING");
  return (
    <WorkspaceContext.Provider value={ctx}>
      <div className="h-full overflow-y-auto xl:grid xl:grid-cols-[minmax(0,1fr)_360px] xl:overflow-hidden">
        <div className="flex min-h-0 flex-col xl:h-full">
          <div className="flex h-12 shrink-0 items-center gap-1.5 border-b px-6 text-[13px]">
            <Link href="/" className="text-muted-foreground hover:text-zinc-900">
              Work
            </Link>
            <ChevronRight className="size-3.5 text-muted-foreground" />
            <span className="font-mono text-[12px] text-zinc-700">{item.id}</span>
            <div className="ml-auto">
              <WorkingNow data={data} />
            </div>
          </div>
          <div className="shrink-0 px-6 pt-5 pb-4">
            <h1 className="text-[18px] leading-snug font-semibold tracking-tight">{item.title}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
              <StateBadge state={item.state} />
              {reworked ? <span className="text-brand-ink">· Reworked after your feedback</span> : null}
            </div>
          </div>
          <DecisionPanel />
          <div className="flex h-10 shrink-0 items-center gap-1 border-t px-5">
            {(["flow", "log"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium",
                  tab === t ? "bg-zinc-100 text-zinc-900" : "text-zinc-500 hover:text-zinc-800",
                )}
              >
                {t === "flow" ? <Workflow className="size-3.5" /> : <ScrollText className="size-3.5" />}
                {t === "flow" ? "Flow" : "Log"}
                {t === "log" ? <span className="text-[11px] text-zinc-400 tnum">{data.activity.length}</span> : null}
              </button>
            ))}
          </div>
          <section className="h-[70vh] min-h-0 border-t xl:h-auto xl:flex-1">{tab === "flow" ? <FlowView /> : <ActivityTimeline />}</section>
        </div>
        <aside className="border-t bg-zinc-50/50 xl:h-full xl:overflow-y-auto xl:border-t-0 xl:border-l">
          <DetailsPanel />
        </aside>
      </div>
      <EvidenceDialog evidenceId={evidenceId} onClose={() => setEvidenceId(null)} />
    </WorkspaceContext.Provider>
  );
}
