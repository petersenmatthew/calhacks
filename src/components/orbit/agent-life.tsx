"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Calculator,
  CircleHelp,
  ClipboardList,
  Database,
  Droplet,
  FileText,
  FlaskConical,
  Gauge,
  History,
  Mail,
  PartyPopper,
  PiggyBank,
  Scale,
  ScrollText,
  Search,
  Send,
  Server,
  Stamp,
  ThumbsUp,
  TrendingUp,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { OrbitNodeId } from "@/lib/frames";
import { cn } from "@/lib/utils";
import type { ActivityRow, DashboardData } from "@/server/queries";
import { PixelAgent, type SpriteMood } from "../pixel-agent";
import { NODE_OF } from "./handoff-runner";

/*
 * Small signs of life on the ring, all driven by recorded activity:
 * what each employee is doing right now, how it reacts to what it finds,
 * and employees walking to the centre seat when they need your approval.
 */

export type Mood = "alert" | "ok" | "sweat" | "nod" | "party" | "question" | "happy";
export type Reaction = { mood: Mood; key: number };
type Agent = DashboardData["agents"][number];
type Approval = DashboardData["openApprovals"][number];
type Visit = { node: OrbitNodeId; label: string; at: number };
type Leave = Visit & { outcome: "approved" | "rejected" };

const WALK = 1700;
const STAMP = 950;
const BACK_HAPPY = 1100;
const BACK_SAD = 2300;
const leaveMs = (o: Leave["outcome"]) => STAMP + (o === "approved" ? BACK_HAPPY : BACK_SAD);

/** Sprite animation for each reaction. */
export function spriteMood(r: Reaction | undefined): SpriteMood | undefined {
  if (r) return ({ alert: "hop", ok: "hop", happy: "hop", sweat: "shake", nod: "nod", party: "party", question: "tilt" } as const)[r.mood];
  return undefined;
}

function approvalLabel(a: Approval) {
  // Summaries often open with history ("PR-2001 was rejected..."); lead with the sentence about what is actually waiting.
  const sentences = a.summary.split(/(?<=[a-z0-9)])\.\s/);
  const first = sentences.find((s) => s.startsWith(a.subjectId)) ?? sentences[0];
  return first.length > 52 ? first.slice(0, 50).trimEnd() + "..." : first;
}

/* ------------------------------------------------------------------ state */

export function useAgentLife(events: ActivityRow[], approvals: Approval[]) {
  const [seen, setSeen] = useState(() => events.reduce((m, e) => Math.max(m, e.id), 0));
  const [reactions, setReactions] = useState<Partial<Record<OrbitNodeId, Reaction>>>({});
  const [known, setKnown] = useState(() => approvals.map((a) => a.id));
  const [arrivals, setArrivals] = useState<Record<string, Visit>>({});
  const [leaving, setLeaving] = useState<Record<string, Leave>>({});
  const latest = useRef({ events, meta: {} as Record<string, { node: OrbitNodeId; label: string }> });
  useEffect(() => {
    latest.current.events = events;
    for (const a of approvals) {
      const node = NODE_OF[a.requestedBy];
      if (node) latest.current.meta[a.id] = { node, label: approvalLabel(a) };
    }
  });

  const react = useCallback((node: OrbitNodeId, mood: Mood) => {
    const key = Math.random();
    setReactions((r) => ({ ...r, [node]: { mood, key } }));
    window.setTimeout(
      () =>
        setReactions((r) => {
          if (r[node]?.key !== key) return r;
          const next = { ...r };
          delete next[node];
          return next;
        }),
      mood === "party" ? 3200 : mood === "nod" ? 1200 : 2600,
    );
  }, []);

  // React to activity that arrives while the canvas is open.
  const freshKey = events
    .filter((e) => e.id > seen)
    .map((e) => e.id)
    .join(",");
  useEffect(() => {
    if (!freshKey) return;
    const raf = requestAnimationFrame(() => {
      const ids = new Set(freshKey.split(",").map(Number));
      const all = latest.current.events;
      const fresh = all.filter((e) => ids.has(e.id)).sort((a, b) => a.id - b.id);
      setSeen((s) => Math.max(s, ...ids));
      const apply = (e: ActivityRow) => {
        const node = NODE_OF[e.actorId];
        if (e.type === "APPROVAL_DECISION") {
          const m = e.changes.join(" ").match(/Approval (\S+): (\w+)/);
          const meta = m ? latest.current.meta[m[1]] : undefined;
          if (!m || !meta) return;
          const outcome = m[2] === "APPROVED" ? "approved" : "rejected";
          const id = m[1];
          setLeaving((l) => ({ ...l, [id]: { ...meta, at: performance.now(), outcome } }));
          window.setTimeout(() => {
            setLeaving((l) => {
              const next = { ...l };
              delete next[id];
              return next;
            });
            if (outcome === "approved") react(meta.node, "happy");
          }, leaveMs(outcome));
          return;
        }
        if (e.type === "COMPLETED") {
          // Everyone who worked on the task celebrates.
          const crew = new Set(all.filter((x) => x.workItemId === e.workItemId).flatMap((x) => (NODE_OF[x.actorId] ? [NODE_OF[x.actorId]] : [])));
          if (node) crew.add(node);
          [...crew].forEach((n, i) => window.setTimeout(() => react(n, "party"), i * 120));
          return;
        }
        if (!node) return;
        if (e.status === "error" || e.status === "denied") return react(node, "sweat");
        if (e.type === "FINDING") {
          const assessment = (e.args as { charge_assessment?: string } | null)?.charge_assessment;
          react(node, assessment === "not_explained" ? "alert" : "ok");
        }
      };
      fresh.forEach((e, i) => window.setTimeout(() => apply(e), i * 300));
    });
    return () => cancelAnimationFrame(raf);
  }, [freshKey, react]);

  // New approval requests: the employee walks to you.
  const newKey = approvals
    .map((a) => a.id)
    .filter((id) => !known.includes(id))
    .join(",");
  useEffect(() => {
    if (!newKey) return;
    const raf = requestAnimationFrame(() => {
      const list = newKey.split(",");
      setKnown((k) => [...k, ...list]);
      const at = performance.now();
      const visits = Object.fromEntries(list.flatMap((id) => (latest.current.meta[id] ? [[id, { ...latest.current.meta[id], at }]] : [])));
      setArrivals((a) => ({ ...a, ...visits }));
      window.setTimeout(
        () =>
          setArrivals((a) => {
            const next = { ...a };
            list.forEach((id) => delete next[id]);
            return next;
          }),
        WALK + 50,
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [newKey]);

  return { reactions, react, arrivals, leaving };
}

/* ------------------------------------------------------------------ seat overlay */

type Act = "sweep" | "tap" | "scribble" | "send";
const TOOL_ACT: Record<string, { icon: LucideIcon; act: Act }> = {
  get_work_item: { icon: FileText, act: "sweep" },
  get_instance_lifecycle: { icon: Server, act: "sweep" },
  get_gpu_job_logs: { icon: Search, act: "sweep" },
  get_experiment: { icon: FlaskConical, act: "sweep" },
  get_provider_usage: { icon: Gauge, act: "sweep" },
  get_billing_terms: { icon: Scale, act: "sweep" },
  find_related_experiments: { icon: Search, act: "sweep" },
  submit_compute_findings: { icon: ClipboardList, act: "scribble" },
  handoff_to_finance: { icon: Mail, act: "send" },
  request_more_info: { icon: CircleHelp, act: "send" },
  get_project_budget: { icon: PiggyBank, act: "sweep" },
  get_allocation_policy: { icon: BookOpen, act: "sweep" },
  search_precedents: { icon: History, act: "sweep" },
  query_ap_history: { icon: Database, act: "sweep" },
  get_posted_charges: { icon: Database, act: "sweep" },
  calculate_cost_allocation: { icon: Calculator, act: "tap" },
  forecast_project_burn: { icon: TrendingUp, act: "tap" },
  propose_adjustment: { icon: ClipboardList, act: "scribble" },
  propose_vendor_dispute: { icon: Scale, act: "scribble" },
  propose_policy: { icon: ScrollText, act: "scribble" },
  propose_materiality_policy: { icon: ScrollText, act: "scribble" },
  record_budget_note: { icon: ClipboardList, act: "scribble" },
  request_human_approval: { icon: Stamp, act: "send" },
  submit_for_posting: { icon: Stamp, act: "tap" },
  get_dispute_package: { icon: FileText, act: "sweep" },
  get_dispute_status: { icon: FileText, act: "sweep" },
  get_vendor_thread: { icon: Mail, act: "sweep" },
  send_vendor_dispute: { icon: Send, act: "send" },
  send_vendor_follow_up: { icon: Send, act: "send" },
  reply_to_vendor: { icon: Send, act: "send" },
  escalate_dispute: { icon: TriangleAlert, act: "send" },
  ask_controller: { icon: CircleHelp, act: "send" },
  request_human_info: { icon: CircleHelp, act: "send" },
  note_vendor_update: { icon: ClipboardList, act: "scribble" },
  record_vendor_decision: { icon: Stamp, act: "tap" },
  close_dispute: { icon: Stamp, act: "tap" },
};

const MOOD_BUBBLE: Record<Mood, { icon?: LucideIcon; text?: string; className: string } | null> = {
  alert: { text: "!", className: "bg-red-500 text-white" },
  ok: { icon: ThumbsUp, className: "bg-emerald-100 text-emerald-700" },
  happy: { icon: ThumbsUp, className: "bg-primary text-zinc-900" },
  sweat: { icon: Droplet, className: "bg-sky-100 text-sky-600" },
  question: { text: "?", className: "bg-white text-zinc-900" },
  party: { icon: PartyPopper, className: "bg-primary text-zinc-900" },
  nod: null,
};

const BUBBLE = "grid h-8 min-w-8 place-items-center rounded-md border-2 border-zinc-900 px-1 font-mono text-[16px] leading-none font-bold shadow-[2px_2px_0_rgb(24_24_27)]";

/** What the employee would say if you asked it what it is up to. */
function speech(agent: Agent | undefined, label: string) {
  if (!agent) return "";
  const said = (t: string) => (t.startsWith(label + " ") ? "I " + t.slice(label.length + 1) : t);
  if (agent.paused) return "I'm paused. Wake me up in the sidebar when you need me.";
  if (agent.status === "working") return (agent.currentTask ? "On it: " + agent.currentTask + "." : "Working on it.") + (agent.latestAction ? " Just now: " + said(agent.latestAction.title) + "." : "");
  if (agent.queued) return agent.queued + (agent.queued === 1 ? " task" : " tasks") + " in my inbox. Starting soon.";
  return agent.latestAction ? "All caught up. Last thing I did: " + said(agent.latestAction.title) + "." : "All caught up.";
}

/** Reaction bubble, guidance sticky note and hover speech around one seat. Positioned on the seat's centre. */
export function SeatLife({ agent, label, reaction, hovered }: { agent?: Agent; label: string; reaction?: Reaction; hovered: boolean }) {
  const [firstGuidance] = useState(() => agent?.guidance ?? "");
  const guidance = agent?.guidance ?? "";
  const mood = reaction ? MOOD_BUBBLE[reaction.mood] : null;
  const Icon = mood?.icon;

  return (
    <>
      {mood && !hovered ? (
        <span className="pointer-events-none absolute z-10" style={{ left: "calc(50% + 16px)", bottom: "calc(50% + 18px)" }}>
          <span key={reaction!.key} className={cn("orbit-spawn", BUBBLE, mood.className)}>
            {Icon ? <Icon className="size-4" strokeWidth={2.5} /> : mood.text}
          </span>
        </span>
      ) : null}
      {guidance ? (
        <span
          key={guidance}
          title={"Your guidance: " + guidance}
          className={cn(
            "pointer-events-auto absolute z-10 grid h-[22px] w-[22px] content-center gap-[3px] rounded-[2px] border border-amber-500/60 bg-amber-200 px-[4px] shadow-[1px_2px_0_rgb(0_0_0/0.12)]",
            guidance !== firstGuidance && "sticky-drop",
          )}
          style={{ left: "calc(50% - 40px)", top: "calc(50% - 40px)", rotate: "-10deg" }}
        >
          <span className="h-px bg-amber-700/50" />
          <span className="h-px bg-amber-700/50" />
          <span className="h-px w-2/3 bg-amber-700/50" />
        </span>
      ) : null}
      {hovered ? (
        <span
          className="orbit-spawn pointer-events-none absolute z-40 w-max max-w-[280px] rounded-xl bg-zinc-900 px-3 py-2 text-[13.5px] leading-snug text-white shadow-lg"
          style={{ left: "50%", bottom: "calc(50% + 40px)", translate: "-50% 0" }}
        >
          {speech(agent, label)}
          <span className="absolute -bottom-1 left-1/2 size-2.5 -translate-x-1/2 rotate-45 bg-zinc-900" />
        </span>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ worker at its frame */

const WSIZE = 38;
const TRAVEL = 750;

/**
 * While an employee works, it leaves its seat and stands on the frame it is building,
 * working with the tool it is using. When it finishes it walks back to its seat.
 * Always mounted; hidden while it is at home.
 */
export function FrameWorker({
  actorId,
  home,
  spot,
  tool,
  dim,
  onAway,
  hidden = false,
}: {
  actorId: string;
  home: { x: number; y: number };
  /** Where to stand, or null to go home. */
  spot: { x: number; y: number } | null;
  tool?: string;
  /** Opacity, to follow the canvas dimming. */
  dim: number;
  /** Whether the seat should look empty. */
  onAway?: (away: boolean) => void;
  /** Out on a hand-off run: keep its place but draw nothing. */
  hidden?: boolean;
}) {
  const goal = spot ?? home;
  const [pos, setPos] = useState(home);
  const [moving, setMoving] = useState(false);
  const [facingLeft, setFacingLeft] = useState(false);
  const [shown, setShown] = useState(false);
  const away = useRef(onAway);
  const at = useRef(home);
  useEffect(() => {
    away.current = onAway;
    at.current = pos;
  });

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const p = at.current;
      if (p.x !== goal.x || p.y !== goal.y) {
        setFacingLeft(goal.x < p.x);
        setMoving(true);
        setPos(goal);
      }
      if (spot) {
        setShown(true);
        away.current?.(true);
      }
    });
    const t = window.setTimeout(() => {
      setMoving(false);
      if (!spot) {
        setShown(false);
        away.current?.(false);
      }
    }, TRAVEL);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
    // Only a change of destination starts a walk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.x, goal.y, Boolean(spot)]);

  if (!shown || hidden) return null;
  const act = tool ? TOOL_ACT[tool] : undefined;
  const Prop = act?.icon;
  const working = !moving && Boolean(spot);
  return (
    <div
      className="pointer-events-none absolute z-30"
      style={{
        left: pos.x - WSIZE / 2,
        top: pos.y - WSIZE,
        width: WSIZE,
        height: WSIZE,
        opacity: dim,
        transition: "left " + TRAVEL + "ms ease-in-out, top " + TRAVEL + "ms ease-in-out, opacity 300ms",
      }}
    >
      <div className={cn(moving && "px-run")} style={{ transform: facingLeft ? "scaleX(-1)" : undefined }}>
        <PixelAgent actorId={actorId} size={WSIZE} working={moving || working} mood={working && act ? (act.act === "tap" || act.act === "scribble" ? "nod" : undefined) : undefined} />
      </div>
      {working ? (
        Prop ? (
          <span className="absolute -left-4 top-[15px] grid size-6 place-items-center rounded-md border-2 border-zinc-900 bg-white shadow-[2px_2px_0_rgb(24_24_27)]">
            <Prop className={cn("size-3.5 text-zinc-800", "act-" + act.act)} strokeWidth={2.5} />
          </span>
        ) : (
          <span className="absolute -top-2 -left-3 flex gap-[3px] rounded-md border-2 border-zinc-900 bg-white px-1.5 py-1.5 shadow-[2px_2px_0_rgb(24_24_27)]">
            {[0, 1, 2].map((i) => (
              <span key={i} className="think-dot size-1 rounded-[1px] bg-zinc-800" style={{ animationDelay: i * 0.15 + "s" }} />
            ))}
          </span>
        )
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ approval visitors */

function useClock(active: boolean) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = (t: number) => {
      setNow(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return now;
}

const VSIZE = 44;
const STAND = 112;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp = (t: number) => Math.max(0, Math.min(1, t));

/**
 * Employees waiting on your approval stand by the centre seat holding the request.
 * New requests walk in; when you decide, the paper is stamped and they go back:
 * a happy run when approved, a slow walk when sent back.
 */
export function ApprovalVisitors({
  approvals,
  arrivals,
  leaving,
  seats,
  center,
  radius,
  hidden,
}: {
  approvals: Approval[];
  arrivals: Record<string, Visit>;
  leaving: Record<string, Leave>;
  seats: Record<OrbitNodeId, { angle: number; actorId: string }>;
  center: { x: number; y: number };
  radius: number;
  hidden: boolean;
}) {
  const now = useClock(Object.keys(arrivals).length + Object.keys(leaving).length > 0);
  if (hidden) return null;
  const pt = (deg: number, r: number) => {
    const a = (deg * Math.PI) / 180;
    return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
  };

  type Figure = { key: string; node: OrbitNodeId; label: string; count: number; x: number; y: number; moving: boolean; facingLeft: boolean; mood?: SpriteMood; stamp?: Leave["outcome"]; paper: boolean };
  const figures: Figure[] = [];

  // Standing (or walking in), one figure per employee.
  const waiting = approvals.filter((a) => !leaving[a.id] && NODE_OF[a.requestedBy]);
  const byNode = new Map<OrbitNodeId, Approval[]>();
  waiting.forEach((a) => byNode.set(NODE_OF[a.requestedBy], [...(byNode.get(NODE_OF[a.requestedBy]) ?? []), a]));
  for (const [node, list] of byNode) {
    const angle = seats[node].angle;
    const from = pt(angle, radius - 36);
    const to = pt(angle, STAND);
    const walk = list.map((a) => arrivals[a.id]).find(Boolean);
    const t = walk ? clamp((now - walk.at) / WALK) : 1;
    const k = ease(t);
    figures.push({
      key: "w-" + node,
      node,
      label: approvalLabel(list.at(-1)!),
      count: list.length,
      x: from.x + (to.x - from.x) * k,
      y: from.y + (to.y - from.y) * k,
      moving: t < 1,
      facingLeft: to.x < from.x,
      paper: true,
    });
  }

  // Leaving after your decision.
  for (const [id, l] of Object.entries(leaving)) {
    const angle = seats[l.node].angle;
    const stand = pt(angle, STAND);
    const home = pt(angle, radius - 36);
    const t = now - l.at;
    const back = l.outcome === "approved" ? BACK_HAPPY : BACK_SAD;
    const k = t < STAMP ? 0 : ease(clamp((t - STAMP) / back));
    figures.push({
      key: "l-" + id,
      node: l.node,
      label: l.label,
      count: 1,
      x: stand.x + (home.x - stand.x) * k,
      y: stand.y + (home.y - stand.y) * k,
      moving: t >= STAMP,
      facingLeft: home.x < stand.x,
      mood: l.outcome === "approved" ? (t < STAMP ? "hop" : undefined) : "slump",
      stamp: l.outcome,
      paper: true,
    });
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {figures.map((f) => (
        <div key={f.key}>
          <div className="absolute" style={{ left: f.x - VSIZE / 2, top: f.y - VSIZE, width: VSIZE, height: VSIZE }}>
            <div className={cn(f.moving && f.mood !== "slump" && "px-run")} style={{ transform: f.facingLeft ? "scaleX(-1)" : undefined }}>
              <PixelAgent actorId={seats[f.node].actorId} size={VSIZE} working={f.moving} mood={f.mood} />
            </div>
          </div>
          {f.paper ? (
            <div
              className="absolute w-max max-w-[220px] rounded-lg bg-white px-2.5 py-1.5 shadow-[0_2px_10px_rgb(0_0_0/0.12)] ring-1 ring-zinc-200"
              style={{ left: f.x, top: f.y - VSIZE - 8, transform: "translate(-50%, -100%)" }}
            >
              <div className="flex items-center gap-1.5 font-mono text-[10px] tracking-wide text-zinc-400 uppercase">
                <Stamp className="size-3" /> Needs your OK{f.count > 1 ? " (" + f.count + ")" : ""}
              </div>
              <div className="mt-0.5 truncate text-[12.5px] font-medium text-zinc-800">{f.label}</div>
              {f.stamp ? (
                <span
                  className={cn(
                    "stamp-in absolute inset-0 grid place-items-center rounded-lg font-mono text-[15px] font-bold tracking-widest",
                    f.stamp === "approved" ? "text-emerald-600" : "text-red-600",
                  )}
                >
                  <span className={cn("rotate-[-10deg] rounded border-[3px] bg-white/85 px-2 py-0.5", f.stamp === "approved" ? "border-emerald-600" : "border-red-600")}>
                    {f.stamp === "approved" ? "APPROVED" : "SENT BACK"}
                  </span>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
