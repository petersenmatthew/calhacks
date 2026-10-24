"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import { clockTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActivityRow, WorkspaceData } from "@/server/queries";
import { ActivityIcon } from "../activity-icon";
import { JsonView } from "../json-view";
import { AgentAvatar, ModeBadge, StateBadge } from "../status";
import { EvidenceChips } from "./evidence-dialog";
import { useWorkspace } from "./workspace-context";

type Group =
  | { kind: "run"; runId: string; events: ActivityRow[] }
  | { kind: "event"; event: ActivityRow };

function groupEvents(events: ActivityRow[]): Group[] {
  const groups: Group[] = [];
  for (const event of events) {
    const last = groups[groups.length - 1];
    if (event.runId) {
      if (last && last.kind === "run" && last.runId === event.runId) last.events.push(event);
      else groups.push({ kind: "run", runId: event.runId, events: [event] });
    } else {
      groups.push({ kind: "event", event });
    }
  }
  return groups;
}

const EMPHASIS: Record<string, string> = {
  FINDING: "border-sky-200 bg-sky-50/60",
  PROPOSAL: "border-violet-200 bg-violet-50/50",
  APPROVAL_REQUEST: "border-orange-200 bg-orange-50/60",
  POLICY: "border-indigo-200 bg-indigo-50/50",
  DENIED: "border-rose-200 bg-rose-50/60",
  ERROR: "border-rose-200 bg-rose-50/60",
  POSTING: "border-emerald-200 bg-emerald-50/50",
  DISPUTE: "border-rose-200 bg-rose-50/40",
  APPROVAL_DECISION: "border-zinc-200 bg-zinc-50",
  HANDOFF: "border-indigo-200 bg-indigo-50/40",
};

function EventRow({ event, data }: { event: ActivityRow; data: WorkspaceData }) {
  const [open, setOpen] = useState(false);
  const hasDetails = Boolean(event.toolName || event.args || event.result || event.evidenceIds.length || event.changes.length);
  const actor = data.actors[event.actorId];
  if (event.type === "STATE_CHANGE") {
    const [from, to] = event.title.split(" -> ");
    return (
      <div className="flex items-center gap-2 py-1 pl-1 text-[11.5px] text-muted-foreground animate-enter">
        <ActivityIcon type="STATE_CHANGE" className="size-5" />
        <StateBadge state={from} />
        <ChevronRight className="size-3" />
        <StateBadge state={to} />
        <span className="truncate">{event.summary}</span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px] tnum">{clockTime(event.createdAt)}</span>
      </div>
    );
  }
  const emphasis = EMPHASIS[event.type];
  return (
    <div className={cn("rounded-lg border animate-enter", emphasis ?? "border-transparent")}>
      <button
        type="button"
        onClick={() => hasDetails && setOpen(!open)}
        className={cn("flex w-full items-start gap-2.5 px-2 py-1.5 text-left", hasDetails && "cursor-pointer", !emphasis && "hover:bg-zinc-50 rounded-lg")}
      >
        <ActivityIcon type={event.type} status={event.status} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] leading-snug font-medium text-zinc-900">{event.title}</span>
          </div>
          {event.summary ? <p className="mt-0.5 text-[12px] leading-snug text-zinc-600">{event.summary}</p> : null}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <span>{actor?.name ?? event.actorId}</span>
            {event.toolName ? <span className="rounded bg-zinc-100 px-1 font-mono text-zinc-600">{event.toolName}</span> : null}
            {event.status === "denied" ? <span className="font-medium text-rose-600">denied</span> : null}
            {event.status === "error" && event.type !== "APPROVAL_DECISION" ? <span className="font-medium text-rose-600">error</span> : null}
            {event.durationMs !== null && event.durationMs !== undefined && event.toolName ? <span className="tnum">{event.durationMs} ms</span> : null}
            {event.evidenceIds.length ? <span>{event.evidenceIds.length} evidence</span> : null}
          </div>
        </div>
        <span className="mt-0.5 shrink-0 font-mono text-[10.5px] text-muted-foreground tnum">{clockTime(event.createdAt)}</span>
        {hasDetails ? <ChevronRight className={cn("mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} /> : null}
      </button>
      {open ? (
        <div className="space-y-2 px-2 pb-2 pl-10">
          {event.changes.length ? (
            <div className="flex flex-wrap gap-1">
              {event.changes.map((c) => (
                <span key={c} className="rounded bg-zinc-900 px-1.5 py-0.5 text-[10.5px] text-white">
                  {c}
                </span>
              ))}
            </div>
          ) : null}
          <EvidenceChips ids={event.evidenceIds} />
          {event.args ? (
            <div>
              <div className="mb-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">Tool arguments</div>
              <JsonView value={event.args} className="max-h-48" />
            </div>
          ) : null}
          {event.result ? (
            <div>
              <div className="mb-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">Returned evidence</div>
              <JsonView value={event.result} className="max-h-64" />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RunGroup({ runId, events, data }: { runId: string; events: ActivityRow[]; data: WorkspaceData }) {
  const run = data.runs.find((r) => r.id === runId);
  const agentId = run?.agentId ?? events[0]?.actorId;
  const name = data.actors[agentId]?.name ?? agentId;
  const body = events.filter((e) => e.type !== "AGENT_STARTED" && e.type !== "AGENT_FINISHED");
  const finished = events.find((e) => e.type === "AGENT_FINISHED");
  const tools = body.filter((e) => e.toolName).length;
  return (
    <div className="rounded-xl border bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <AgentAvatar actorId={agentId} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-semibold">{name}</span>
            <ModeBadge mode={run?.mode} />
            <span className="font-mono text-[10.5px] text-muted-foreground">{runId}</span>
          </div>
          <div className="truncate text-[11.5px] text-muted-foreground">{run?.task}</div>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="tnum">{tools} tool calls</span>
          {run?.status === "running" ? (
            <span className="flex items-center gap-1 font-medium text-blue-700">
              <LoaderCircle className="size-3.5 animate-spin" /> working
            </span>
          ) : run?.status === "completed" ? (
            <span className="flex items-center gap-1 font-medium text-emerald-700">
              <CircleCheck className="size-3.5" /> done
            </span>
          ) : run?.status === "failed" ? (
            <span className="flex items-center gap-1 font-medium text-rose-600">
              <CircleX className="size-3.5" /> failed
            </span>
          ) : null}
        </div>
      </div>
      <div className="space-y-1 p-2">
        {body.map((e) => (
          <EventRow key={e.id} event={e} data={data} />
        ))}
        {run?.status === "running" ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-[12px] text-muted-foreground">
            <span className="flex gap-0.5">
              <span className="size-1.5 animate-bounce rounded-full bg-blue-500 [animation-delay:-0.2s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-blue-500 [animation-delay:-0.1s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-blue-500" />
            </span>
            {name} is {run.mode === "llm" ? "deciding the next tool call" : "running the next step"}
          </div>
        ) : null}
        {finished ? (
          <div className="flex items-center gap-2 px-2 pt-1 text-[11.5px] text-muted-foreground">
            <ActivityIcon type="AGENT_FINISHED" className="size-5" />
            <span className="text-zinc-700">{finished.title}</span>
            <span>· {finished.summary}</span>
          </div>
        ) : null}
        {run?.status === "failed" && run.error ? <div className="px-2 text-[11.5px] text-rose-600">{run.error}</div> : null}
      </div>
    </div>
  );
}

export function ActivityTimeline() {
  const { data } = useWorkspace();
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const initial = useRef(true);
  const groups = groupEvents(data.activity);
  const count = data.activity.length;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (initial.current || pinned.current) {
      el.scrollTop = el.scrollHeight;
      initial.current = false;
    }
  }, [count]);

  const toolCalls = data.activity.filter((e) => e.toolName).length;
  const findings = data.activity.filter((e) => e.type === "FINDING").length;
  const denied = data.activity.filter((e) => e.status === "denied" || e.type === "ERROR").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold">Live agent activity</h2>
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-700">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" /> Live
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span>Written by the backend as agents call tools and people decide</span>
          <span className="tnum">{toolCalls} tool calls</span>
          <span className="tnum">{findings} findings</span>
          {denied ? <span className="text-rose-600 tnum">{denied} rejected</span> : null}
        </div>
      </div>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-zinc-50/60 p-4"
      >
        {groups.map((g) =>
          g.kind === "run" ? (
            <RunGroup key={g.runId + ":" + g.events[0].id} runId={g.runId} events={g.events} data={data} />
          ) : (
            <div key={g.event.id} className="px-1">
              <EventRow event={g.event} data={data} />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
