"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { ArrowUpRight, ChevronDown, LoaderCircle } from "lucide-react";
import { agentSteps, EMPLOYEE_IDS } from "@/lib/agent-steps";
import { fetcher } from "@/lib/api";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardData, WorkspaceData } from "@/server/queries";
import { useLiveRefresh } from "../live-events";
import { Orbit } from "../orbit/orbit";
import { AgentAvatar, StateBadge } from "../status";

function lastRun(w: WorkspaceData, agentId: string) {
  const run = w.runs.filter((r) => r.agentId === agentId).at(-1);
  const tools = run ? w.activity.filter((e) => e.runId === run.id && e.toolName).map((e) => e.toolName!) : [];
  const status = run?.status === "running" || run?.status === "completed" || run?.status === "failed" ? run.status : "none";
  const queued = w.agents.some((a) => a.agentId === agentId && a.status === "queued" && a.currentWorkItemId === w.item.id);
  return { run, status, queued, ...agentSteps(agentId, tools, status) } as const;
}

type Items = DashboardData["workItems"];

/** Floating card in the top-right corner: which task the canvas shows, and where it stands. */
function TaskPanel({ items, id, onSelect, w }: { items: Items; id: string | undefined; onSelect: (id: string) => void; w?: WorkspaceData }) {
  const [collapsed, setCollapsed] = useState(false);
  const pending = w?.approvals.find((a) => a.status === "PENDING");
  const asking = w?.item.state === "NEEDS_INFO";
  const busy = w ? EMPLOYEE_IDS.map((a) => ({ a, r: lastRun(w, a) })).find((x) => x.r.status === "running" || x.r.queued) : undefined;
  return (
    <div className="card-soft absolute top-4 right-4 z-40 lg:-right-[332px] w-[320px] max-w-[calc(100%-2rem)] overflow-hidden">
      <div className="flex h-10 items-center gap-1 border-b bg-zinc-50/80 pr-1 pl-2">
        <select
          aria-label="Task shown on canvas"
          value={id ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          disabled={!items.length}
          className="h-7 min-w-0 flex-1 truncate rounded-md bg-transparent px-1 font-mono text-[11.5px] text-zinc-700 outline-none hover:bg-zinc-100"
        >
          {!items.length && <option value="">No tasks this period</option>}
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id} · {item.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand task" : "Collapse task"}
          className="grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100"
        >
          <ChevronDown className={cn("size-4 transition-transform", collapsed && "-rotate-90")} />
        </button>
      </div>
      {!collapsed && w ? (
        <div className="space-y-3 p-4">
          <div>
            <div className="text-[14px] leading-snug font-semibold">{w.item.title}</div>
            <div className="mt-1 flex items-center gap-2">
              <StateBadge state={w.item.state} />
            </div>
          </div>
          <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-muted-foreground">Provider</dt>
            <dd className="truncate text-zinc-800">{w.providers[w.item.providerId]?.name}</dd>
            <dt className="text-muted-foreground">Resource</dt>
            <dd className="truncate font-mono text-[11.5px] text-zinc-800">{w.item.instanceId ?? w.item.reservationId}</dd>
            <dt className="text-muted-foreground">Charge</dt>
            <dd className="text-zinc-800 tnum">{money(w.item.invoicedCents)}</dd>
          </dl>
          {busy ? (
            <div className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-[12px] ring-1 ring-zinc-200/70">
              <AgentAvatar actorId={busy.a} size="sm" />
              <span className="flex-1 truncate text-zinc-700">{w.actors[busy.a]?.name}</span>
              <span className="flex items-center gap-1 text-brand-ink">
                {busy.r.status === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {busy.r.status === "running" ? (busy.r.current?.verb ?? "Working") : "Queued"}
              </span>
            </div>
          ) : null}
          {pending || asking ? (
            <div className="rounded-lg bg-accent px-3 py-2.5">
              <div className="text-[12.5px] font-medium text-brand-ink">{pending ? "Waiting on your approval" : "An agent has a question"}</div>
              {pending ? <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-zinc-700">{pending.summary}</p> : null}
              <Link
                href={"/investigations/" + w.item.id}
                className="mt-2 inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground hover:opacity-90"
              >
                Review <ArrowUpRight className="size-3.5" />
              </Link>
            </div>
          ) : (
            <Link href={"/investigations/" + w.item.id} className="inline-flex items-center gap-1 text-[12px] text-brand-ink hover:underline">
              Open task <ArrowUpRight className="size-3.5" />
            </Link>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ConnectedCanvas({ overview, id, items, onSelect }: { overview: DashboardData; id: string; items: Items; onSelect: (id: string) => void }) {
  const { data, mutate } = useSWR<WorkspaceData>(`/api/work-items/${id}`, fetcher, { keepPreviousData: true });
  useLiveRefresh(() => mutate(), (event) => event.workItemId === id || event.workItemId === null, 150);
  return (
    <>
      <Orbit overview={overview} w={data} />
      <TaskPanel items={items} id={id} onSelect={onSelect} w={data} />
    </>
  );
}

export function SystemCanvas({ data }: { data: DashboardData }) {
  const [selected, setSelected] = useState<string | null>(null);
  const items = data.workItems.filter((item) => item.period === data.period);
  const id = items.some((item) => item.id === selected)
    ? selected!
    : (items.find((item) => data.agents.some((a) => a.currentWorkItemId === item.id))?.id ?? items[0]?.id);
  return (
    <div className="bg-dots relative h-full min-h-0">
      <div className="relative h-full lg:mr-[336px]">
        {id ? (
          <ConnectedCanvas key={id} overview={data} id={id} items={items} onSelect={setSelected} />
        ) : (
          <>
            <Orbit overview={data} />
            <TaskPanel items={items} id={undefined} onSelect={setSelected} />
          </>
        )}
      </div>
    </div>
  );
}

