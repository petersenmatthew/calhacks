"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, CircleCheck, CircleX, LoaderCircle } from "lucide-react";
import { clockTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActivityRow, WorkspaceData } from "@/server/queries";
import { ActivityIcon } from "../activity-icon";
import { JsonView } from "../json-view";
import { useLiveConnected } from "../live-events";
import { AgentAvatar, modeLabel, STATE_META } from "../status";
import { EvidenceChips } from "./evidence-dialog";
import { useWorkspace } from "./workspace-context";

type Group = { kind: "run"; runId: string; events: ActivityRow[] } | { kind: "event"; event: ActivityRow };

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

function isBad(event: ActivityRow) {
  return event.status === "denied" || event.type === "DENIED" || event.type === "ERROR" || (event.status === "error" && event.type !== "APPROVAL_DECISION");
}

function Time({ iso }: { iso: string }) {
  return <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground tnum">{clockTime(iso)}</span>;
}

function EventRow({ event, data, showActor }: { event: ActivityRow; data: WorkspaceData; showActor: boolean }) {
  const [open, setOpen] = useState(false);
  const hasDetails = Boolean(event.args || event.result || event.evidenceIds.length || event.changes.length);
  const bad = isBad(event);

  if (event.type === "STATE_CHANGE") {
    const [from, to] = event.title.split(" -> ");
    return (
      <div className="flex items-center gap-2 py-1 text-[11.5px] text-muted-foreground animate-enter">
        <ActivityIcon type="STATE_CHANGE" />
        <span className="min-w-0 flex-1 truncate">
          {STATE_META[from]?.label ?? from} <span className="text-zinc-300">→</span> <span className="text-zinc-700">{STATE_META[to]?.label ?? to}</span>
        </span>
        <Time iso={event.createdAt} />
      </div>
    );
  }

  const compact = event.type === "TOOL_CALL" && !bad;
  return (
    <div className="animate-enter">
      <button
        type="button"
        onClick={() => hasDetails && setOpen(!open)}
        className={cn("-mx-1.5 flex w-[calc(100%+12px)] items-start gap-2 rounded-md px-1.5 py-1 text-left", hasDetails && "cursor-pointer hover:bg-zinc-50")}
      >
        <ActivityIcon type={event.type} status={event.status} />
        <div className="min-w-0 flex-1">
          {compact ? (
            <div className="flex items-baseline gap-2">
              <span className="truncate text-[12.5px] text-zinc-600">{event.title}</span>
              {event.toolName ? <span className="hidden shrink-0 font-mono text-[10.5px] text-zinc-400 sm:inline">{event.toolName}</span> : null}
            </div>
          ) : (
            <>
              <div className={cn("text-[13px] leading-snug font-medium", bad ? "text-destructive" : "text-zinc-900")}>{event.title}</div>
              {event.summary ? <p className="mt-0.5 text-[12.5px] leading-snug text-zinc-600">{event.summary}</p> : null}
              {showActor || bad || event.evidenceIds.length ? (
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                  {showActor ? <span>{data.actors[event.actorId]?.name ?? event.actorId}</span> : null}
                  {bad ? <span className="font-medium text-destructive">{event.status === "denied" || event.type === "DENIED" ? "denied" : "error"}</span> : null}
                  {event.evidenceIds.length ? <span>{event.evidenceIds.length} evidence</span> : null}
                </div>
              ) : null}
            </>
          )}
        </div>
        <Time iso={event.createdAt} />
        {hasDetails ? <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} /> : <span className="w-3.5" />}
      </button>
      {open ? (
        <div className="space-y-2 pt-1 pb-2 pl-7">
          {event.changes.length ? <div className="text-[11.5px] text-zinc-700">Changed: {event.changes.join(", ")}</div> : null}
          <EvidenceChips ids={event.evidenceIds} />
          {event.args ? (
            <div>
              <div className="mb-1 text-[11px] text-muted-foreground">Arguments</div>
              <JsonView value={event.args} className="max-h-48" />
            </div>
          ) : null}
          {event.result ? (
            <div>
              <div className="mb-1 text-[11px] text-muted-foreground">Result</div>
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
    <div className="py-2">
      <div className="flex items-center gap-2.5">
        <AgentAvatar actorId={agentId} />
        <span className="text-[13px] font-semibold">{name}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted-foreground">{run?.task}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground tnum">
          {tools} tool calls{run?.mode ? " · " + modeLabel(run.mode) : ""}
        </span>
        {run?.status === "running" ? (
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-brand-ink">
            <LoaderCircle className="size-3.5 animate-spin" /> Working
          </span>
        ) : run?.status === "completed" ? (
          <CircleCheck className="size-3.5 shrink-0 text-brand-ink" />
        ) : run?.status === "failed" ? (
          <span className="flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-destructive">
            <CircleX className="size-3.5" /> Failed
          </span>
        ) : null}
      </div>
      <div className="mt-1 ml-3 border-l pl-5">
        {body.map((e) => (
          <EventRow key={e.id} event={e} data={data} showActor={e.actorId !== agentId} />
        ))}
        {run?.status === "running" ? (
          <div className="flex items-center gap-2 py-1.5 text-[12px] text-muted-foreground">
            <span className="flex w-5 justify-center gap-0.5">
              <span className="size-1 animate-bounce rounded-full bg-primary [animation-delay:-0.2s]" />
              <span className="size-1 animate-bounce rounded-full bg-primary [animation-delay:-0.1s]" />
              <span className="size-1 animate-bounce rounded-full bg-primary" />
            </span>
            {run.mode === "llm" ? "Choosing the next tool" : "Running the next step"}
          </div>
        ) : null}
        {finished ? (
          <div className="flex items-center gap-2 py-1 text-[11.5px] text-muted-foreground">
            <ActivityIcon type="AGENT_FINISHED" />
            <span className="min-w-0 flex-1 truncate">
              {finished.title}
              {finished.summary ? " · " + finished.summary : ""}
            </span>
          </div>
        ) : null}
        {run?.status === "failed" && run.error ? <div className="py-1 text-[12px] text-destructive">{run.error}</div> : null}
      </div>
    </div>
  );
}

export function ActivityTimeline() {
  const { data } = useWorkspace();
  const connected = useLiveConnected();
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
  const rejected = data.activity.filter(isBad).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 px-6">
        <span className={cn("size-1.5 rounded-full", connected ? "animate-pulse bg-primary" : "bg-zinc-300")} title={connected ? "Live" : "Reconnecting"} />
        <span className="ml-auto text-[11.5px] text-muted-foreground tnum">
          {data.runs.length} runs · {toolCalls} tool calls
          {rejected ? <span className="text-destructive"> · {rejected} rejected</span> : null}
        </span>
      </div>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-6 pt-1 pb-6"
      >
        {groups.map((g) =>
          g.kind === "run" ? (
            <RunGroup key={g.runId + ":" + g.events[0].id} runId={g.runId} events={g.events} data={data} />
          ) : (
            <EventRow key={g.event.id} event={g.event} data={data} showActor />
          ),
        )}
      </div>
    </div>
  );
}
