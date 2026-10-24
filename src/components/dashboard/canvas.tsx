"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { fetcher } from "@/lib/api";
import { buildDecision, shortTitle } from "@/lib/decision";
import { buildFrames, type Frame } from "@/lib/frames";
import type { DashboardData, WorkspaceData } from "@/server/queries";
import { groupOf, Sidebar, type FrameChatTarget } from "../canvas/sidebar";
import { useLiveRefresh } from "../live-events";
import { AgentPanel } from "../orbit/agent-panel";
import { EMPLOYEES, Orbit, type Focus } from "../orbit/orbit";
import { Caption } from "./caption";

/** How many recently active tasks feed the canvas when no task is focused. */
const RECENT = 8;

/** Frames from several tasks share one canvas, so their ids carry the task id. */
function tagged(w: WorkspaceData): Frame[] {
  return buildFrames(w).map((f) => ({ ...f, id: w.item.id + ":" + f.id, members: f.members?.map((m) => w.item.id + ":" + m) }));
}

async function fetchMany([, ...ids]: string[]) {
  return Promise.all(ids.map((id) => fetcher<WorkspaceData>("/api/work-items/" + id)));
}

/**
 * The canvas and its sidebar. With no task focused, each seat shows its latest
 * work across recent tasks. Focusing a task shows only that task's frames.
 */
export function SystemCanvas({ data, initialTask = null, onChanged }: { data: DashboardData; initialTask?: string | null; onChanged: () => void }) {
  const items = useMemo(() => data.workItems.filter((i) => i.period === data.period), [data]);
  const [picked, setPicked] = useState<string | null>(initialTask);
  // The canvas follows the case the team is on, including one that starts while
  // the page is open (a new task, or the next case in line). If the person
  // opened some other task themselves, it stays there until they come back.
  const [autoOpen, setAutoOpen] = useState(initialTask === null);
  const [lastLive, setLastLive] = useState<string | null>(null);
  const live = data.activeWorkItemId && items.some((i) => i.id === data.activeWorkItemId) ? data.activeWorkItemId : null;
  if (live && live !== lastLive) {
    const following = autoOpen || picked === null || picked === lastLive;
    setLastLive(live);
    if (following) {
      setAutoOpen(false);
      setPicked(live);
    }
  }
  const task = picked;
  const oneAtATime = data.settings.runMode === "one";
  const [focus, setFocus] = useState<Focus>(null);

  const setTask = (id: string | null) => {
    setPicked(id);
    setAutoOpen(false);
    setFocus(null);
    window.history.replaceState(null, "", id ? "/canvas?task=" + id : "/canvas");
  };

  const recentIds = items.slice(0, RECENT).map((i) => i.id);
  const recent = useSWR<WorkspaceData[]>(task ? null : ["canvas-frames", ...recentIds], fetchMany, { keepPreviousData: true });
  const one = useSWR<WorkspaceData>(task ? "/api/work-items/" + task : null, fetcher);
  useLiveRefresh(() => (task ? one.mutate() : recent.mutate()), task ? (e) => e.workItemId === task || e.workItemId === null : undefined, task ? 150 : 600);

  const w = one.data && one.data.item.id === task ? one.data : undefined;
  const frames = useMemo(() => {
    if (task) return w ? tagged(w) : [];
    return (recent.data ?? []).flatMap(tagged).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [task, w, recent.data]);

  const current = task ? items.find((i) => i.id === task) : undefined;
  const seat = focus?.kind === "node" ? EMPLOYEES.find((e) => e.id === focus.id) : undefined;
  const openFrame = focus?.kind === "frame" ? frames.find((f) => f.id === focus.id) : undefined;
  const frameSeat = openFrame ? EMPLOYEES.find((e) => e.id === openFrame.node) : undefined;
  const frameChat: FrameChatTarget | undefined =
    openFrame && frameSeat
      ? {
          key: openFrame.id,
          taskId: openFrame.id.slice(0, openFrame.id.indexOf(":")),
          frameId: openFrame.id.slice(openFrame.id.indexOf(":") + 1),
          actorId: frameSeat.actorId,
          agentName: data.actors[frameSeat.actorId]?.name ?? frameSeat.label,
          job: frameSeat.job,
          label: openFrame.label,
          title: openFrame.spec.title,
          tone: openFrame.tone,
        }
      : undefined;

  const next = () => {
    const needs = items.filter((i) => groupOf(i) === "needs");
    const at = needs.findIndex((i) => i.id === task);
    const rest = [...needs.slice(at + 1), ...needs.slice(0, Math.max(at, 0))].filter((i) => i.id !== task);
    if (rest[0]) setTask(rest[0].id);
    else {
      setTask(null);
      toast.success("All clear. Nothing else needs you.");
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="bg-dots relative min-w-0 flex-1">
        <Orbit
          overview={data}
          frames={frames}
          w={w}
          focus={focus}
          setFocus={setFocus}
          task={current ? { id: current.id, label: shortTitle(current, data.providers) } : null}
          onClearTask={task ? () => setTask(null) : undefined}
          onYou={() => {
            const first = items.find((i) => groupOf(i) === "needs");
            if (first) setTask(first.id);
          }}
        />
        <Caption data={data} />
      </div>
      <Sidebar
        data={data}
        items={items}
        task={task}
        w={w}
        onTask={setTask}
        frameChat={frameChat}
        onCloseFrame={() => setFocus(null)}
        onDecided={async () => {
          onChanged();
          // One at a time: stay on this case to watch it finish.
          if (oneAtATime) return;
          // Let the confirmation read for a beat. Stay when the same task still has
          // something waiting, such as a new rule plus the redone split.
          await new Promise((r) => window.setTimeout(r, 900));
          const fresh = await one.mutate();
          if (fresh && buildDecision(fresh)) return;
          next();
        }}
        agentPanel={
          seat ? (
            <AgentPanel
              key={seat.id}
              actorId={seat.actorId}
              currentItemId={task ?? undefined}
              onClose={() => setFocus(null)}
              onOpenTask={setTask}
              openOutput={(activityId, workItemId) => {
                const id = workItemId + ":act-" + activityId;
                const hit = frames.find((f) => f.id === id || f.members?.includes(id));
                if (!hit) return false;
                setFocus({ kind: "frame", id: hit.id });
                return true;
              }}
            />
          ) : undefined
        }
      />
    </div>
  );
}

