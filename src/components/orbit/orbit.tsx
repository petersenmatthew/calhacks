"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, LoaderCircle, RotateCcw, X } from "lucide-react";
import { boardStage } from "@/lib/agent-steps";
import { type Frame, type OrbitNodeId } from "@/lib/frames";
import { cn } from "@/lib/utils";
import type { DashboardData, WorkspaceData } from "@/server/queries";
import { AgentAvatar } from "../status";
import { PixelAgent, spriteTint } from "../pixel-agent";
import { buildTime, DH, DW, FrameView } from "./frame-view";
import { HandoffRunner, handoffsFrom } from "./handoff-runner";

/* ------------------------------------------------------------------ geometry */

// The canvas is drawn in a fixed coordinate space; a camera transform fits or zooms it.
const W = 1600;
const H = 960;
const CX = W / 2;
const CY = H / 2;
const NODE_W = 224;
const NODE_H = 60;
const FW = 128;
const FH = 96;
const GAP = 14;
const REACH = 40;
const INNER = FW / DW;

/** Frames created this recently before the canvas opened, or any time after, build in one at a time. */
const FRESH_MS = 30_000;
/** Wait before the next new frame starts building. Shorter when several are queued. */
const NEXT_MS = 2200;
const NEXT_BUSY_MS = 700;
/** Lets the spawn pop finish before the frame starts filling in. */
const BUILD_DELAY = 350;

/**
 * New frames enter one at a time and fill in on the card, so a burst of records
 * written in one request (a billing event and its rule checks) reads as a sequence.
 */
function useStagedFrames(frames: Frame[]) {
  const [since] = useState(() => Date.now() - FRESH_MS);
  const [revealed, setRevealed] = useState<Record<string, true>>({});
  const [building, setBuilding] = useState<Record<string, true>>({});
  const lastAt = useRef(0);
  const timers = useRef<number[]>([]);

  const pending = frames
    .filter((f) => f.tone !== "live" && !revealed[f.id] && Date.parse(f.createdAt) > since)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // Live refreshes rebuild frame objects, so the timer keys on the id and duration.
  const headId = pending[0]?.id;
  const headTime = pending[0] ? buildTime(pending[0].spec) : 0;
  const backlog = pending.length;

  useEffect(() => {
    if (!headId) return;
    const wait = Math.max(0, lastAt.current + (backlog > 2 ? NEXT_BUSY_MS : NEXT_MS) - Date.now());
    const id = window.setTimeout(() => {
      lastAt.current = Date.now();
      setRevealed((r) => ({ ...r, [headId]: true }));
      setBuilding((b) => ({ ...b, [headId]: true }));
      const done = window.setTimeout(() => {
        setBuilding((b) => {
          const next = { ...b };
          delete next[headId];
          return next;
        });
      }, BUILD_DELAY + headTime);
      timers.current.push(done);
    }, wait);
    return () => window.clearTimeout(id);
  }, [headId, headTime, backlog]);

  useEffect(() => {
    const list = timers.current;
    return () => list.forEach((t) => window.clearTimeout(t));
  }, []);

  const hidden = new Set(pending.map((f) => f.id));
  // The working indicator waits until the records it works from have appeared.
  const visible = frames.filter((f) => !hidden.has(f.id) && !(f.tone === "live" && backlog > 0));
  return { visible, building };
}

type Layout = "up" | "down" | "left" | "right";

/**
 * Seats on the ring are employees: AI agents with one job each. Code they rely on
 * (intake rules, the ledger gateway, policy memory) shows up inside their work, and
 * the ring itself is the orchestrator passing work between them.
 */
export const EMPLOYEES: { id: OrbitNodeId; actorId: string; label: string; job: string; dept: string }[] = [
  { id: "compute", actorId: "agent.compute", label: "Compute Investigator", job: "What actually ran", dept: "FinOps" },
  { id: "finance", actorId: "agent.finance", label: "Cost Accountant", job: "Charges teams, books", dept: "Accounting" },
  { id: "vendor", actorId: "agent.vendor", label: "Vendor Liaison", job: "Disputes and credits", dept: "Payables" },
  { id: "budget", actorId: "agent.budget", label: "Budget Analyst", job: "Team burn vs budget", dept: "FP&A" },
  { id: "policy", actorId: "agent.policy", label: "Policy Analyst", job: "Learns rules from you", dept: "Controls" },
  { id: "capacity", actorId: "agent.capacity", label: "Capacity Planner", job: "Reserved GPU use", dept: "Procurement" },
];

/*
 * Draft seat styles for review, picked with ?seats=tile|dot|ring. "current" is the existing card.
 * Temporary: remove the others once one is chosen.
 */
type SeatStyle = "current" | "tile" | "dot" | "ring";
const SEAT_STYLES: SeatStyle[] = ["current", "tile", "dot", "ring"];

function readSeatStyle(): SeatStyle {
  const v = new URLSearchParams(window.location.search).get("seats");
  return SEAT_STYLES.includes(v as SeatStyle) ? (v as SeatStyle) : "ring";
}

function useSeatStyle() {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("popstate", cb);
      return () => window.removeEventListener("popstate", cb);
    },
    readSeatStyle,
    () => "ring" as SeatStyle,
  );
}

const R = EMPLOYEES.length <= 2 ? 200 : 270;
// Fewer seats leave room for taller frame grids.
const MAX_FRAMES = EMPLOYEES.length > 3 ? 6 : 9;

/** With two seats the ring is mostly empty, so it carries a label saying it is the orchestrator. Six seats leave no room. */
const SHOW_RING_LABEL = EMPLOYEES.length <= 3;
const LABEL_ARC: [number, number] = [155, 25];

function layoutFor(angle: number): Layout {
  const c = Math.cos((angle * Math.PI) / 180);
  if (c < -0.3) return "left";
  if (c > 0.3) return "right";
  return Math.sin((angle * Math.PI) / 180) < 0 ? "up" : "down";
}

// Spread seats evenly. Two seats start on the left; more start at the top and go clockwise.
const START = EMPLOYEES.length > 3 ? -90 : 180;
const NODES = EMPLOYEES.map((e, i) => {
  const angle = (((START + (i * 360) / EMPLOYEES.length) % 360) + 360) % 360;
  return { ...e, angle, layout: layoutFor(angle) };
});
const NODE = Object.fromEntries(NODES.map((n) => [n.id, n])) as Record<OrbitNodeId, (typeof NODES)[number]>;

function at(angle: number) {
  const a = (angle * Math.PI) / 180;
  return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
}

/** Top-left corner of each frame slot around a node. Grids snake row by row so the order reads as one path. */
function slots(id: OrbitNodeId, count: number) {
  const { angle, layout } = NODE[id];
  const p = at(angle);
  const out: { x: number; y: number }[] = [];
  if (layout === "up" || layout === "down") {
    const width = count * FW + (count - 1) * GAP;
    const y = layout === "up" ? p.y - NODE_H / 2 - REACH - FH : p.y + NODE_H / 2 + REACH;
    for (let i = 0; i < count; i++) out.push({ x: p.x - width / 2 + i * (FW + GAP), y });
    return out;
  }
  const rows = Math.ceil(count / 3);
  const top = p.y - (rows * FH + (rows - 1) * GAP) / 2;
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 3);
    const col = row % 2 === 0 ? i % 3 : 2 - (i % 3);
    const near = layout === "right" ? p.x + NODE_W / 2 + REACH : p.x - NODE_W / 2 - REACH - FW;
    out.push({ x: layout === "right" ? near + col * (FW + GAP) : near - col * (FW + GAP), y: top + row * (FH + GAP) });
  }
  return out;
}

/** Path from a node into its first frame, then frame to frame in order. */
function chain(id: OrbitNodeId, pos: { x: number; y: number }[]) {
  if (!pos.length) return { entry: "", links: [] as string[] };
  const { angle, layout } = NODE[id];
  const p = at(angle);
  const first = pos[0];
  let entry: string;
  if (layout === "up" || layout === "down") {
    const edge = layout === "up" ? first.y + FH : first.y;
    const spine = layout === "up" ? edge + 22 : edge - 22;
    entry = "M " + p.x + " " + (layout === "up" ? p.y - NODE_H / 2 : p.y + NODE_H / 2) + " V " + spine + " H " + (first.x + FW / 2) + " V " + edge;
  } else {
    const right = layout === "right";
    const edge = right ? first.x : first.x + FW;
    const spine = right ? edge - 22 : edge + 22;
    const y = first.y + FH / 2;
    entry = "M " + (right ? p.x + NODE_W / 2 : p.x - NODE_W / 2) + " " + p.y + " H " + spine + (y !== p.y ? " V " + y : "") + " H " + edge;
  }
  const links = pos.slice(1).map((b, i) => {
    const a = pos[i];
    if (a.y === b.y) {
      const y = a.y + FH / 2;
      return b.x > a.x ? "M " + (a.x + FW) + " " + y + " H " + b.x : "M " + a.x + " " + y + " H " + (b.x + FW);
    }
    const x = a.x + FW / 2;
    return "M " + x + " " + (a.y + FH) + " V " + b.y;
  });
  return { entry, links };
}

/** Clockwise along the ring from one seat to another. */
function ringArc(from: OrbitNodeId, to: OrbitNodeId) {
  const a = at(NODE[from].angle);
  const b = at(NODE[to].angle);
  const span = (NODE[to].angle - NODE[from].angle + 360) % 360;
  return "M " + a.x + " " + a.y + " A " + R + " " + R + " 0 " + (span > 180 ? 1 : 0) + " 1 " + b.x + " " + b.y;
}

function spoke(from: OrbitNodeId | "you", to: OrbitNodeId | "you") {
  const a = from === "you" ? { x: CX, y: CY } : at(NODE[from].angle);
  const b = to === "you" ? { x: CX, y: CY } : at(NODE[to].angle);
  return "M " + a.x + " " + a.y + " L " + b.x + " " + b.y;
}

/* ------------------------------------------------------------------ live state */

type FlowState = "idle" | "done" | "active";

/** Lines between seats light up while work moves along them and stay faintly drawn once it has. */
function flows(w?: WorkspaceData): { key: string; d: string; state: FlowState }[] {
  if (!w) return [];
  const ran = (id: string) => w.runs.some((r) => r.agentId === id);
  const busy = (id: string) =>
    w.runs.filter((r) => r.agentId === id).at(-1)?.status === "running" ||
    w.agents.some((a) => a.agentId === id && a.status === "queued" && a.currentWorkItemId === w.item.id);
  const state = (active: boolean, done: boolean): FlowState => (active ? "active" : done ? "done" : "idle");
  const investigator = w.item.type === "SHARED_ALLOCATION" ? "capacity" : "compute";
  const handoffs = w.activity.filter((e) => e.toolName === "handoff_to_finance");
  const lastHandoff = handoffs.at(-1)?.actorId;
  const handedOff = (actorId: string) => handoffs.some((e) => e.actorId === actorId);
  const pending = w.approvals.filter((a) => a.status === "PENDING");
  const decided = w.approvals.filter((a) => a.status !== "PENDING");
  const financeBusy = busy("agent.finance");
  return [
    {
      key: investigator + "-finance",
      d: ringArc(investigator, "finance"),
      state: state(financeBusy && lastHandoff === "agent." + investigator, handedOff("agent." + investigator)),
    },
    { key: "finance-you", d: spoke("finance", "you"), state: state(pending.length > 0 || w.item.state === "NEEDS_INFO", decided.length > 0) },
    { key: "you-policy", d: spoke("you", "policy"), state: state(busy("agent.policy"), ran("agent.policy")) },
    { key: "policy-finance", d: ringArc("policy", "finance"), state: state(financeBusy && lastHandoff === "agent.policy", handedOff("agent.policy")) },
    { key: "you-vendor", d: spoke("you", "vendor"), state: state(busy("agent.vendor"), ran("agent.vendor")) },
    { key: "finance-budget", d: ringArc("finance", "budget"), state: state(busy("agent.budget"), ran("agent.budget")) },
  ];
}

type Stat = { tone: "wait" | "work" | "done"; n: number };

function stats(id: OrbitNodeId, o: DashboardData): Stat[] {
  const a = o.agents.find((x) => x.agentId === NODE[id].actorId);
  return [
    { tone: "wait", n: a?.queued ?? 0 },
    { tone: "work", n: a?.status === "working" ? 1 : 0 },
    { tone: "done", n: a?.completedRuns ?? 0 },
  ];
}

/* ------------------------------------------------------------------ pieces */

function useViewport() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, size };
}

function StatChip({ items }: { items: Stat[] }) {
  return (
    <span className="flex items-center gap-2 rounded-lg bg-white px-2 py-1 font-mono text-[11px] text-zinc-600 shadow-xs ring-1 ring-zinc-200 tnum">
      {items.map((s) => (
        <span key={s.tone} className={cn("flex items-center gap-1", s.n === 0 && "opacity-40")}>
          {s.tone === "work" ? (
            <LoaderCircle className={cn("size-3 text-brand-ink", s.n > 0 && "animate-spin")} />
          ) : (
            <span className={cn("size-2 rounded-full", s.tone === "wait" ? "bg-amber-400" : "bg-emerald-500")} />
          )}
          {s.n}
        </span>
      ))}
    </span>
  );
}

const TONE_DOT: Record<Frame["tone"], string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-400",
  denied: "bg-red-500",
  live: "bg-primary animate-pulse",
};

function FrameCard({
  frame,
  x,
  y,
  focused,
  building,
  k,
  dim,
  lit,
  replay,
  onOpen,
  onHover,
  onMeasure,
}: {
  frame: Frame;
  x: number;
  y: number;
  focused: boolean;
  /** Newly arrived: fill in on the card instead of appearing finished. */
  building: boolean;
  k: number;
  dim: boolean;
  lit: boolean;
  replay: number;
  onOpen: () => void;
  onHover: (on: boolean) => void;
  /** Reports the frame's full content height (in frame units) so a focused frame can show all of it. */
  onMeasure: (id: string, h: number) => void;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [contentH, setContentH] = useState(DH);
  const id = frame.id;
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = Math.max(DH, el.scrollHeight);
      setContentH(h);
      onMeasure(id, h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onMeasure, id]);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={"Open " + frame.label + ": " + frame.spec.title}
      title={focused ? undefined : frame.spec.title}
      onClick={(e) => {
        e.stopPropagation();
        if (!focused) onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !focused) onOpen();
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className={cn(
        "orbit-spawn absolute overflow-hidden bg-white transition-[opacity,height] duration-500 outline-none",
        !focused && "cursor-zoom-in rounded-[10px] shadow-[0_1px_2px_rgb(0_0_0/0.05),0_6px_16px_rgb(0_0_0/0.06)] ring-1 ring-zinc-200 hover:ring-zinc-400 focus-visible:ring-2 focus-visible:ring-primary",
        !focused && lit && "ring-zinc-400",
        !focused && frame.tone === "live" && "ring-2 ring-primary",
        !focused && frame.tone === "denied" && "ring-red-300",
      )}
      style={{
        left: x,
        top: y,
        width: FW,
        height: focused ? contentH * INNER : FH,
        opacity: dim ? 0.12 : 1,
        zIndex: focused ? 50 : 10,
        ...(focused ? { borderRadius: 16 / k, boxShadow: "0 0 0 " + 1 / k + "px rgb(212 212 216), 0 " + 16 / k + "px " + 48 / k + "px rgb(0 0 0 / 0.14)" } : null),
      }}
    >
      <div ref={inner} style={{ width: DW, transform: "scale(" + INNER + ")", transformOrigin: "0 0" }}>
        <FrameView
          key={focused && replay ? "play-" + replay : "still"}
          spec={frame.spec}
          play={building || (focused && replay > 0)}
          delay={building ? BUILD_DELAY : 300}
          fit
          open={focused}
        />
      </div>
      <div
        className={cn(
          "absolute inset-x-0 bottom-0 flex h-[18px] items-center gap-1 border-t border-zinc-100 bg-white/95 px-1.5 text-[9.5px] font-medium text-zinc-600 transition-opacity",
          focused && "opacity-0",
        )}
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[frame.tone])} />
        <span className="truncate">{frame.label}</span>
        {frame.tone === "live" ? (
          <LoaderCircle className="ml-auto size-2.5 shrink-0 animate-spin text-brand-ink" />
        ) : frame.spec.source ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={frame.spec.source.logo} alt={frame.spec.source.name} title={"From " + frame.spec.source.name} className="ml-auto size-3 shrink-0 rounded-[3px]" />
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ canvas */

export type Focus = { kind: "node"; id: OrbitNodeId } | { kind: "frame"; id: string } | null;

/**
 * The ring of employees and the frames of work around each seat. The parent owns
 * which frames are shown (every task, or one) and what is focused, so the sidebar
 * can follow along.
 */
export function Orbit({
  overview,
  frames,
  w,
  focus,
  setFocus,
  task,
  onClearTask,
  onYou,
}: {
  overview: DashboardData;
  frames: Frame[];
  /** The focused task, used to light up the hand-offs it took. */
  w?: WorkspaceData;
  focus: Focus;
  setFocus: (f: Focus) => void;
  /** Short label of the focused task, shown in the breadcrumb. */
  task?: { id: string; label: string } | null;
  onClearTask?: () => void;
  /** The centre seat: start reviewing what is waiting. */
  onYou?: () => void;
}) {
  const { ref, size } = useViewport();
  const [hover, setHover] = useState<OrbitNodeId | null>(null);
  const [replay, setReplay] = useState(0);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const measure = useCallback((id: string, h: number) => setHeights((m) => (m[id] === h ? m : { ...m, [id]: h })), []);
  const { visible, building } = useStagedFrames(frames);

  // Lay out the newest frames for each node.
  const placed = new Map<string, { frame: Frame; x: number; y: number }>();
  const groups = NODES.map((n) => {
    const all = visible.filter((f) => f.node === n.id);
    const shown = all.slice(-MAX_FRAMES);
    const pos = slots(n.id, shown.length || 2);
    shown.forEach((f, i) => placed.set(f.id, { frame: f, ...pos[i] }));
    return { node: n, shown, hidden: all.length - shown.length, pos };
  });

  const focusedFrame = focus?.kind === "frame" ? placed.get(focus.id) : undefined;
  // Replay is per visit: opening another frame shows it finished.
  const [replayFor, setReplayFor] = useState<string | null>(null);
  const focusedId = focusedFrame?.frame.id ?? null;
  if (focusedId !== replayFor) {
    setReplayFor(focusedId);
    setReplay(0);
  }
  const focusH = focusedFrame ? Math.max(DH, heights[focusedFrame.frame.id] ?? DH) * INNER : FH;
  const focusNode: OrbitNodeId | null = focus?.kind === "node" ? focus.id : (focusedFrame?.frame.node ?? null);
  const level: "all" | "node" | "frame" = focusedFrame ? "frame" : focusNode ? "node" : "all";

  // Camera: where the viewport centre sits in canvas space, and the zoom.
  // Fit what is actually drawn: the ring, its seats, and the frames shown.
  const boxes = [
    { x0: CX - R, x1: CX + R, y0: CY - R, y1: CY + R },
    ...groups.flatMap((g) => g.pos.slice(0, g.shown.length).map((s) => ({ x0: s.x, x1: s.x + FW, y0: s.y, y1: s.y + FH }))),
  ];
  const bx0 = Math.min(...boxes.map((b) => b.x0)) - 56;
  const bx1 = Math.max(...boxes.map((b) => b.x1)) + 56;
  const by0 = Math.min(...boxes.map((b) => b.y0)) - 72;
  const by1 = Math.max(...boxes.map((b) => b.y1)) + 56;
  const fit = size.w && size.h ? Math.min(size.w / (bx1 - bx0), size.h / (by1 - by0)) : 1;
  let cam = { x: (bx0 + bx1) / 2, y: (by0 + by1) / 2, k: fit };
  if (focusedFrame) {
    // Leave room for the breadcrumb bar above and the step controls below.
    const k = Math.min((0.72 * size.w) / FW, (size.h - 150) / focusH, 1.25 / INNER);
    cam = { x: focusedFrame.x + FW / 2, y: focusedFrame.y + focusH / 2 - 20 / k, k };
  } else if (focusNode) {
    const g = groups.find((x) => x.node.id === focusNode)!;
    const p = at(g.node.angle);
    const shownPos = g.pos.slice(0, g.shown.length);
    const xs = [p.x - NODE_W / 2, p.x + NODE_W / 2, ...shownPos.flatMap((s) => [s.x, s.x + FW])];
    const ys = [p.y - NODE_H / 2 - 36, p.y + NODE_H / 2, ...shownPos.flatMap((s) => [s.y, s.y + FH])];
    const [x0, x1, y0, y1] = [Math.min(...xs) - 48, Math.max(...xs) + 48, Math.min(...ys) - 48, Math.max(...ys) + 48];
    cam = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, k: Math.min(Math.min(size.w / (x1 - x0), size.h / (y1 - y0)) * 0.9, fit * 3.2) };
  }
  const transform = "translate(" + (size.w / 2 - cam.x * cam.k) + "px, " + (size.h / 2 - cam.y * cam.k) + "px) scale(" + cam.k + ")";

  const order = groups.flatMap((g) => g.shown.map((f) => f.id));
  const step = (dir: 1 | -1) => {
    if (!focusedFrame) return;
    const i = order.indexOf(focusedFrame.frame.id);
    const next = order[(i + dir + order.length) % order.length];
    if (next) setFocus({ kind: "frame", id: next });
  };
  const up = () => setFocus(focusedFrame ? { kind: "node", id: focusedFrame.frame.node } : null);
  const escape = () => (focus ? up() : onClearTask?.());

  const keys = useRef({ escape, step, replay: () => setReplay((r) => r + 1) });
  useEffect(() => {
    keys.current = { escape, step, replay: () => setReplay((r) => r + 1) };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "Escape") keys.current.escape();
      if (e.key === "ArrowRight") keys.current.step(1);
      if (e.key === "ArrowLeft") keys.current.step(-1);
      if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey) keys.current.replay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const waiting = overview.workItems.filter((i) => i.period === overview.period && boardStage(i) === "needs_you").length;
  const here = w ? w.approvals.some((a) => a.status === "PENDING") || w.item.state === "NEEDS_INFO" : waiting > 0;
  const running = (aid: string) => overview.agents.some((a) => a.agentId === aid && a.status === "working");
  const seatStyle = useSeatStyle();
  const live = Object.fromEntries(NODES.map((n) => [n.id, running(n.actorId)])) as Partial<Record<OrbitNodeId, boolean>>;
  const edges = flows(w);
  const handoffs = handoffsFrom(w ? w.activity : overview.activity);
  const dimNode = (id: OrbitNodeId) => level !== "all" && focusNode !== id;
  const lit = (id: OrbitNodeId) => level !== "frame" && hover === id;
  const hoverOn = (id: OrbitNodeId) => (on: boolean) => setHover((h) => (on ? id : h === id ? null : h));

  return (
    <div ref={ref} className="absolute inset-0" onClick={up}>
      <div className="absolute inset-0 overflow-hidden">
      {size.w ? (
        <div
          className="absolute top-0 left-0"
          style={{ width: W, height: H, transform, transformOrigin: "0 0", transition: "transform 750ms cubic-bezier(0.22, 1, 0.36, 1)" }}
        >
          <svg aria-hidden="true" width={W} height={H} className={cn("pointer-events-none absolute inset-0 overflow-visible transition-opacity duration-500", level === "frame" && "opacity-20")}>
            <defs>
              {(["rgb(212 212 216)", "var(--brand-ink)"] as const).map((c, i) => (
                <marker key={c} id={"orbit-arrow-" + i} viewBox="0 0 6 6" refX={5.5} refY={3} markerWidth={6} markerHeight={6} markerUnits="userSpaceOnUse" orient="auto">
                  <path d="M 0.5 0.5 L 5.5 3 L 0.5 5.5" fill="none" stroke={c} strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" />
                </marker>
              ))}
            </defs>
            <circle cx={CX} cy={CY} r={R} fill="none" stroke="rgb(212 212 216)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {SHOW_RING_LABEL ? (
              <>
                <path id="orbit-ring-label" d={"M " + at(LABEL_ARC[0]).x + " " + at(LABEL_ARC[0]).y + " A " + R + " " + R + " 0 0 0 " + at(LABEL_ARC[1]).x + " " + at(LABEL_ARC[1]).y} fill="none" />
                <text className="fill-zinc-400 font-mono text-[10px] tracking-[0.2em] uppercase">
                  <textPath href="#orbit-ring-label" startOffset="50%" textAnchor="middle">
                    Orchestrator passes work around the ring
                  </textPath>
                </text>
              </>
            ) : null}
            {NODES.map((n) => (
              <path key={n.id} d={spoke("you", n.id)} stroke="rgb(212 212 216)" strokeDasharray="4 6" fill="none" vectorEffect="non-scaling-stroke" />
            ))}
            {groups.map((g) => {
              // No arrows out of a seat with nothing to show yet.
              if (!g.shown.length) return null;
              const { entry, links } = chain(g.node.id, g.pos);
              const on = lit(g.node.id);
              const marker = "url(#orbit-arrow-" + (on ? 1 : 0) + ")";
              return (
                <g key={"c-" + g.node.id} opacity={dimNode(g.node.id) ? 0.3 : 1}>
                  {[entry, ...links].map((d, i) => (
                    <path
                      key={i}
                      d={d}
                      stroke={on ? "var(--brand-ink)" : "rgb(212 212 216)"}
                      strokeWidth={on ? 1.5 : 1}
                      strokeDasharray={!on && i === 0 ? "3 5" : undefined}
                      className={on && i === 0 ? "flow-dash" : undefined}
                      markerEnd={marker}
                      fill="none"
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </g>
              );
            })}
            {edges
              .filter((e) => e.state !== "idle")
              .map((e) =>
                e.state === "done" ? (
                  <path key={e.key} d={e.d} stroke="var(--brand-ink)" strokeOpacity={0.35} strokeWidth={1.5} fill="none" vectorEffect="non-scaling-stroke" />
                ) : (
                  <g key={e.key}>
                    <path d={e.d} stroke="var(--primary)" strokeWidth={2} fill="none" className="flow-dash" vectorEffect="non-scaling-stroke" />
                    {[0, 0.45, 0.9].map((delay) => (
                      <rect key={delay} x={-3.5} y={-3.5} width={7} height={7} rx={1.5} fill="var(--brand-ink)">
                        <animateMotion dur="1.6s" begin={delay + "s"} repeatCount="indefinite" path={e.d} />
                      </rect>
                    ))}
                  </g>
                ),
              )}
          </svg>

          {groups.map((g) =>
            g.shown.length
              ? g.shown.map((f, i) => (
                  <FrameCard
                    key={f.id}
                    frame={f}
                    x={g.pos[i].x}
                    y={g.pos[i].y}
                    k={cam.k}
                    focused={focusedFrame?.frame.id === f.id}
                    building={Boolean(building[f.id])}
                    dim={level === "frame" ? focusedFrame?.frame.id !== f.id : dimNode(g.node.id)}
                    lit={lit(g.node.id)}
                    replay={replay}
                    onOpen={() => setFocus({ kind: "frame", id: f.id })}
                    onHover={hoverOn(g.node.id)}
                    onMeasure={measure}
                  />
                ))
              : null,
          )}

          {groups.map((g) => {
            const p = at(g.node.angle);
            return (
              <div
                key={g.node.id}
                className="absolute z-20 transition-opacity duration-500"
                style={{ left: p.x - NODE_W / 2, top: p.y - NODE_H / 2, width: NODE_W, height: NODE_H, opacity: level === "frame" ? 0.12 : dimNode(g.node.id) ? 0.35 : 1 }}
              >
                {seatStyle === "current" ? (
                  <>
                    <div className="absolute -top-9 left-1/2 -translate-x-1/2">
                      <StatChip items={stats(g.node.id, overview)} />
                    </div>
                    <button
                      type="button"
                      aria-label={g.node.label}
                      onClick={(e) => {
                        e.stopPropagation();
                    setFocus({ kind: "node", id: g.node.id });
                      }}
                      onMouseEnter={() => hoverOn(g.node.id)(true)}
                      onMouseLeave={() => hoverOn(g.node.id)(false)}
                      onFocus={() => hoverOn(g.node.id)(true)}
                      onBlur={() => hoverOn(g.node.id)(false)}
                      className={cn(
                        "flex size-full cursor-zoom-in items-center gap-2.5 rounded-xl bg-white pr-3 pl-2.5 text-left shadow-sm ring-1 ring-zinc-200 hover:ring-zinc-400",
                        lit(g.node.id) && "ring-zinc-400",
                        live[g.node.id] && "ring-2 ring-primary",
                      )}
                    >
                      <AgentAvatar actorId={g.node.actorId} size="lg" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-[14.5px] leading-tight font-medium text-zinc-800">
                          <span className="truncate">{g.node.label}</span>
                          {live[g.node.id] ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-brand-ink" /> : null}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] leading-tight text-zinc-500">
                          {g.node.job}
                        </span>
                      </span>
                    </button>
                  </>
                ) : seatStyle === "tile" ? (
                  <>
                    <div className="absolute -top-9 left-1/2 -translate-x-1/2">
                      <StatChip items={stats(g.node.id, overview)} />
                    </div>
                    <button
                      type="button"
                      aria-label={g.node.dept}
                      onClick={(e) => {
                        e.stopPropagation();
                    setFocus({ kind: "node", id: g.node.id });
                      }}
                      onMouseEnter={() => hoverOn(g.node.id)(true)}
                      onMouseLeave={() => hoverOn(g.node.id)(false)}
                      onFocus={() => hoverOn(g.node.id)(true)}
                      onBlur={() => hoverOn(g.node.id)(false)}
                      className={cn(
                        "absolute top-1/2 left-1/2 flex h-14 w-[150px] -translate-x-1/2 -translate-y-1/2 cursor-zoom-in items-center justify-center rounded-lg border border-zinc-200 bg-white text-[16px] text-zinc-600 shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-colors hover:border-zinc-300 hover:text-zinc-900",
                        lit(g.node.id) && "border-zinc-300 text-zinc-900",
                        live[g.node.id] && "border-zinc-400 text-zinc-900",
                      )}
                    >
                      {g.node.dept}
                    </button>
                  </>
                ) : seatStyle === "dot" ? (
                  <button
                    type="button"
                    aria-label={g.node.dept}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFocus({ kind: "node", id: g.node.id });
                  }}
                  onMouseEnter={() => hoverOn(g.node.id)(true)}
                  onMouseLeave={() => hoverOn(g.node.id)(false)}
                  onFocus={() => hoverOn(g.node.id)(true)}
                  onBlur={() => hoverOn(g.node.id)(false)}
                    className={cn(
                      "absolute top-1/2 left-1/2 flex h-10 -translate-x-1/2 -translate-y-1/2 cursor-zoom-in items-center gap-2 rounded-full border border-zinc-200 bg-white pr-4 pl-3 text-[14px] whitespace-nowrap text-zinc-600 transition-colors hover:border-zinc-300 hover:text-zinc-900",
                      lit(g.node.id) && "border-zinc-300 text-zinc-900",
                    )}
                    title={stats(g.node.id, overview).map((s) => s.n + " " + s.tone).join(" · ")}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        live[g.node.id] ? "animate-pulse bg-primary ring-4 ring-primary/25" : stats(g.node.id, overview)[0].n ? "bg-amber-400" : "bg-zinc-300",
                      )}
                    />
                    {g.node.dept}
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={g.node.dept}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFocus({ kind: "node", id: g.node.id });
                  }}
                  onMouseEnter={() => hoverOn(g.node.id)(true)}
                  onMouseLeave={() => hoverOn(g.node.id)(false)}
                  onFocus={() => hoverOn(g.node.id)(true)}
                  onBlur={() => hoverOn(g.node.id)(false)}
                    className="group absolute inset-0 cursor-zoom-in"
                  >
                    <span
                      className={cn(
                        "absolute top-1/2 left-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-2xl border border-zinc-200 transition-[transform,border-color] duration-200 group-hover:-translate-y-[calc(50%+2px)] group-hover:border-zinc-300",
                        lit(g.node.id) && "border-zinc-400",
                        live[g.node.id] && "border-primary ring-4 ring-primary/25",
                      )}
                      style={{ background: spriteTint(g.node.actorId) }}
                    >
                      <PixelAgent actorId={g.node.actorId} size={40} working={Boolean(live[g.node.id])} />
                    </span>
                    <span
                      className={cn(
                        "absolute flex flex-col gap-0.5 whitespace-nowrap",
                        (g.node.layout === "right" || g.node.layout === "up" || g.node.layout === "down") && "top-1/2 left-1/2 ml-10 -translate-y-1/2 items-start",
                        g.node.layout === "left" && "top-1/2 right-1/2 mr-10 -translate-y-1/2 items-end",
                      )}
                    >
                      <span className={cn("text-[15px] text-zinc-500 transition-colors group-hover:text-zinc-900", (lit(g.node.id) || live[g.node.id]) && "text-zinc-900")}>
                        {g.node.dept}
                      </span>
                      <span className="font-mono text-[10px] text-zinc-400 tnum">
                        {stats(g.node.id, overview).map((s) => s.n).join(" · ")}
                      </span>
                    </span>
                  </button>
                )}
                {g.hidden > 0 ? (
                  <span className="absolute top-1/2 -right-2 translate-x-full -translate-y-1/2 font-mono text-[10px] text-zinc-400">+{g.hidden}</span>
                ) : null}
              </div>
            );
          })}

          <div
            className="absolute z-20 transition-opacity duration-500"
            style={{ left: CX - 90, top: CY - 60, width: 180, height: 140, opacity: level === "all" ? 1 : 0.15 }}
          >
            <YouCard here={Boolean(here)} label={w ? (here ? "your call" : "all clear") : waiting ? waiting + (waiting === 1 ? " needs you" : " need you") : "all clear"} onClick={onYou} />
          </div>

          <HandoffRunner handoffs={handoffs} seats={NODE} center={{ x: CX, y: CY }} radius={R} hidden={level === "frame"} />
        </div>
      ) : null}
      </div>

      <Toolbar
        level={level}
        task={task ?? null}
        onClearTask={onClearTask}
        nodeLabel={focusNode ? NODE[focusNode].label : null}
        frameLabel={focusedFrame?.frame.label ?? null}
        zoom={Math.round((cam.k / fit) * 100)}
        onHome={() => setFocus(null)}
        onNode={() => focusNode && setFocus({ kind: "node", id: focusNode })}
        onBack={up}
        onStep={step}
        onReplay={() => setReplay((r) => r + 1)}
      />
    </div>
  );
}

/** The centre seat: you, drawn like the employees. A quest marker pops up when something waits on you. */
function YouCard({ here, label, onClick }: { here: boolean; label: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      disabled={!here || !onClick}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className="group relative flex size-full flex-col items-center justify-start pt-3 enabled:cursor-pointer"
    >
      <span
        className={cn(
          "relative grid size-20 place-items-center rounded-[22px] border border-zinc-200 transition-[transform,border-color] duration-200 group-enabled:group-hover:-translate-y-0.5",
          here && "border-primary ring-4 ring-primary/25",
        )}
        style={{ background: spriteTint("you") }}
      >
        <PixelAgent actorId="you" size={58} working={here} />
        {here ? (
          <span className="px-bob-fast absolute -top-3 -right-2 grid h-7 min-w-7 place-items-center rounded-md border-2 border-zinc-900 bg-primary px-1 font-mono text-[15px] leading-none font-bold text-zinc-900 shadow-[2px_2px_0_rgb(24_24_27)]">
            !
          </span>
        ) : null}
      </span>
      <span className="mt-2 text-[15px] leading-none text-zinc-900">You</span>
      <span className={cn("mt-1 font-mono text-[10px] tnum", here ? "text-zinc-600" : "text-zinc-400")}>{label}</span>
    </button>
  );
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid size-8 place-items-center rounded-lg text-zinc-600 hover:bg-zinc-100"
    >
      {children}
    </button>
  );
}

function Toolbar({
  level,
  task,
  onClearTask,
  nodeLabel,
  frameLabel,
  zoom,
  onHome,
  onNode,
  onBack,
  onStep,
  onReplay,
}: {
  level: "all" | "node" | "frame";
  task: { id: string; label: string } | null;
  onClearTask?: () => void;
  nodeLabel: string | null;
  frameLabel: string | null;
  zoom: number;
  onHome: () => void;
  onNode: () => void;
  onBack: () => void;
  onStep: (dir: 1 | -1) => void;
  onReplay: () => void;
}) {
  const crumb = "rounded-md px-1.5 py-0.5 hover:bg-zinc-100";
  return (
    <div className="absolute top-4 left-4 z-40 flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
      <div className="card-soft flex h-11 items-center gap-1 pr-2 pl-1.5">
        {level !== "all" ? (
          <ToolButton label="Zoom out" onClick={onBack}>
            <ArrowLeft className="size-4" />
          </ToolButton>
        ) : (
          <span className="grid size-8 place-items-center rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-600">AR</span>
        )}
        <nav className="flex items-center gap-0.5 text-[13.5px] text-zinc-500">
          <button
            type="button"
            onClick={() => {
              onHome();
              onClearTask?.();
            }}
            className={cn(crumb, level === "all" && !task && "font-medium text-zinc-800")}
          >
            Atlas Research
          </button>
          {task ? (
            <>
              <ChevronRight className="size-3.5 text-zinc-300" />
              <span className="flex items-center gap-1 rounded-md bg-accent py-0.5 pr-1 pl-1.5 text-zinc-800">
                <button type="button" onClick={onHome} className={cn("max-w-[220px] truncate", level === "all" && "font-medium")}>
                  {task.label}
                </button>
                <button type="button" onClick={onClearTask} aria-label="Show all work" title="Show all work (Esc)" className="grid size-4 place-items-center rounded text-zinc-500 hover:bg-white/70 hover:text-zinc-900">
                  <X className="size-3" />
                </button>
              </span>
            </>
          ) : null}
          {nodeLabel ? (
            <>
              <ChevronRight className="size-3.5 text-zinc-300" />
              <button type="button" onClick={onNode} className={cn(crumb, level === "node" && "font-medium text-zinc-800")}>
                {nodeLabel}
              </button>
            </>
          ) : null}
          {frameLabel ? (
            <>
              <ChevronRight className="size-3.5 text-zinc-300" />
              <span className="px-1.5 font-medium text-zinc-800">{frameLabel}</span>
            </>
          ) : null}
        </nav>
      </div>
      <span className="font-mono text-[12px] text-zinc-400 tnum">Z {zoom}%</span>
      {level === "frame" ? (
        <div className="card-soft fixed bottom-6 left-6 z-40 flex h-11 items-center gap-0.5 px-1">
          <ToolButton label="Previous frame" onClick={() => onStep(-1)}>
            <ChevronLeft className="size-4" />
          </ToolButton>
          <ToolButton label="Replay (R)" onClick={onReplay}>
            <RotateCcw className="size-4" />
          </ToolButton>
          <ToolButton label="Next frame" onClick={() => onStep(1)}>
            <ChevronRight className="size-4" />
          </ToolButton>
        </div>
      ) : null}
    </div>
  );
}

