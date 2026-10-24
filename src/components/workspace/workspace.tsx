"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { Check, ChevronRight } from "lucide-react";
import { fetcher } from "@/lib/api";
import { money, periodLabel, relativeTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import type { WorkspaceData } from "@/server/queries";
import { useLiveRefresh } from "../live-events";
import { PRIORITY_LABEL, PriorityIcon, StateBadge } from "../status";
import { Skeleton } from "../ui/skeleton";
import { ActivityTimeline } from "./activity-timeline";
import { ContextPanel } from "./context-panel";
import { EvidenceDialog } from "./evidence-dialog";
import { TeamPanel } from "./team-panel";
import { WorkspaceContext } from "./workspace-context";

const STEPS = ["NEW", "INVESTIGATING", "PROPOSED", "NEEDS_APPROVAL", "APPROVED", "SETTLED", "RESOLVED"];

function Stepper({ data }: { data: WorkspaceData }) {
  const visited = new Set(data.transitions.map((t) => t.toState));
  const settled = visited.has("DISPUTED") ? "DISPUTED" : "POSTED";
  const current = data.item.state;
  const reworked = data.transitions.some((t) => t.fromState === "NEEDS_APPROVAL" && t.toState === "INVESTIGATING");
  return (
    <div className="flex flex-wrap items-center gap-1">
      {STEPS.map((step, i) => {
        const state = step === "SETTLED" ? settled : step;
        const isCurrent = current === state;
        const done = visited.has(state) && !isCurrent;
        const label = state.replace("_", " ");
        return (
          <div key={step} className="flex items-center gap-1">
            <span
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full px-2 font-mono text-[10.5px] tracking-tight",
                isCurrent ? "bg-zinc-900 text-white" : done ? "bg-zinc-100 text-zinc-700" : "text-zinc-400 ring-1 ring-zinc-200 ring-inset",
              )}
            >
              {done ? <Check className="size-3" /> : null}
              {label}
            </span>
            {i < STEPS.length - 1 ? <ChevronRight className="size-3 text-zinc-300" /> : null}
          </div>
        );
      })}
      {reworked ? <span className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-800">reworked after controller feedback</span> : null}
    </div>
  );
}

export function Workspace({ id }: { id: string }) {
  const now = useNow();
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const { data, error, mutate } = useSWR<WorkspaceData>("/api/work-items/" + id, fetcher, { keepPreviousData: true });
  useLiveRefresh(() => mutate(), (event) => event.workItemId === id || event.workItemId === null, 150);
  const ctx = useMemo(() => (data ? { data, openEvidence: setEvidenceId, refresh: () => void mutate() } : null), [data, mutate]);

  if (error && !data) {
    return (
      <div className="p-8 text-[13px]">
        <div className="font-medium">Could not open {id}</div>
        <div className="mt-1 text-muted-foreground">{String(error.message)}</div>
        <Link href="/" className="mt-3 inline-block text-blue-700 hover:underline">
          Back to operations
        </Link>
      </div>
    );
  }
  if (!data || !ctx) {
    return (
      <div className="grid h-full grid-cols-1 gap-4 p-6 xl:grid-cols-[380px_1fr_380px]">
        <Skeleton className="h-full rounded-xl" />
        <Skeleton className="h-full rounded-xl" />
        <Skeleton className="h-full rounded-xl" />
      </div>
    );
  }
  const item = data.item;
  return (
    <WorkspaceContext.Provider value={ctx}>
      <div className="flex h-full flex-col">
        <div className="shrink-0 space-y-2 border-b bg-white px-5 py-3">
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Link href="/" className="hover:text-zinc-900">
              Operations
            </Link>
            <ChevronRight className="size-3" />
            <span className="font-mono text-zinc-700">{item.id}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-[17px] font-semibold tracking-tight">{item.title}</h1>
            <StateBadge state={item.state} />
            <span className="flex items-center gap-1 text-[12px] text-muted-foreground">
              <PriorityIcon priority={item.priority} /> {PRIORITY_LABEL[item.priority]}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
            <span>{item.type === "BILLING_VARIANCE" ? "Billing variance" : "Shared allocation"}</span>
            <span>·</span>
            <span>{data.providers[item.providerId]?.name}</span>
            <span>·</span>
            <span className="font-mono">{item.instanceId ?? item.reservationId}</span>
            <span>·</span>
            <span className="tnum">{money(item.amountCents)}</span>
            <span>·</span>
            <span>{periodLabel(item.period)}</span>
            <span>·</span>
            <span>opened {relativeTime(item.createdAt, now)}</span>
          </div>
          <Stepper data={data} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto xl:grid xl:grid-cols-[minmax(320px,370px)_minmax(0,1fr)_minmax(330px,380px)] xl:grid-rows-[minmax(0,1fr)] xl:overflow-hidden">
          <section className="border-b bg-white xl:h-full xl:overflow-y-auto xl:border-r xl:border-b-0">
            <ContextPanel />
          </section>
          <section className="h-[80vh] border-b xl:h-full xl:border-b-0">
            <ActivityTimeline />
          </section>
          <section className="bg-zinc-50/60 xl:h-full xl:overflow-y-auto xl:border-l">
            <TeamPanel />
          </section>
        </div>
      </div>
      <EvidenceDialog evidenceId={evidenceId} onClose={() => setEvidenceId(null)} />
    </WorkspaceContext.Provider>
  );
}
