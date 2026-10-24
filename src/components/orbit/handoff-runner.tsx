"use client";

import { useEffect, useRef, useState } from "react";
import { Mail, ScrollText } from "lucide-react";
import type { OrbitNodeId } from "@/lib/frames";
import { compactMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActivityRow } from "@/server/queries";
import { PixelAgent } from "../pixel-agent";

/*
 * Hand-offs as a scene: the sender's pixel character runs around the ring to the
 * receiver carrying a note that says what it is passing, hands it over, and walks back.
 * A newly active policy is carried all the way around, and every seat nods as it passes.
 */

export type Handoff = {
  id: number;
  workItemId: string | null;
  from: OrbitNodeId;
  to: OrbitNodeId;
  kind: "handoff" | "question" | "broadcast";
  /** What is being passed, in a few words. */
  label: string;
  /** The sender's note. */
  detail: string;
  createdAt: string;
};

type Seat = { angle: number; actorId: string; label: string };

export const NODE_OF: Record<string, OrbitNodeId> = {
  "agent.compute": "compute",
  "agent.finance": "finance",
  "agent.vendor": "vendor",
  "agent.budget": "budget",
  "agent.policy": "policy",
  "agent.capacity": "capacity",
};

function get(o: unknown, path: string): unknown {
  let cur: unknown = o;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Agent-to-agent hand-offs in a list of activity, oldest first. */
export function handoffsFrom(events: ActivityRow[]): Handoff[] {
  const rows = [...events].sort((a, b) => a.id - b.id);
  const out: Handoff[] = [];
  rows.forEach((e, i) => {
    if (e.status !== "ok") return;
    const base = { id: e.id, workItemId: e.workItemId, detail: (e.summary ?? "").trim(), createdAt: e.createdAt };
    const active = e.title.match(/^Policy (.+) is now active/);
    if (active) {
      out.push({ ...base, from: "policy", to: "policy", kind: "broadcast", label: "New rule: " + active[1] });
      return;
    }
    const from = NODE_OF[e.actorId];
    if (!from) return;
    if (e.toolName === "handoff_to_finance") {
      let label = from === "policy" ? "Policy check" : "Findings";
      const finding = rows
        .slice(0, i)
        .reverse()
        .find((f) => f.workItemId === e.workItemId && f.toolName === "submit_compute_findings" && f.status === "ok");
      if (finding) {
        const gap = Number(get(finding.result, "computed.discrepancy_cents") ?? 0);
        const assessment = String(get(finding.args, "charge_assessment") ?? "");
        label =
          gap > 0 ? "Findings: " + compactMoney(gap) + " unsupported" : assessment === "explained" ? "Findings: charge checks out" : "Findings: usage by project";
      }
      out.push({ ...base, from, to: "finance", kind: "handoff", label });
    } else if (e.toolName === "request_more_info") {
      const to = String(get(e.result, "handed_off_to") ?? "").includes("Capacity") ? "capacity" : "compute";
      out.push({ ...base, from, to, kind: "question", label: "Question" });
    }
  });
  return out;
}

/* ------------------------------------------------------------------ timing */

const HOP = 380;
const FADE = 300;
const SPEED = 0.22; // canvas px per ms
const SIZE = 48;
const OFF = 10; // degrees: start and stop beside the seat, not on it
const JUMP = 13; // degrees either side of a seat it passes, where it jumps over

function plan(h: Handoff, seats: Record<OrbitNodeId, Seat>, R: number) {
  const a = seats[h.from].angle;
  if (h.kind === "broadcast") {
    const span = 360 - 2 * OFF;
    const run = Math.min(6000, (span * Math.PI * R) / 180 / SPEED);
    return { start: a + OFF, end: a + OFF + span, span, dir: 1, run, give: 500, back: 0, total: HOP + run + 500 + FADE };
  }
  const b = seats[h.to].angle;
  const delta = ((b - a + 540) % 360) - 180;
  const dir = Math.sign(delta) || 1;
  const start = a + dir * OFF;
  const end = b - dir * OFF;
  const span = end - start;
  const run = Math.min(3400, Math.max(1100, (Math.abs(span) * Math.PI * R) / 180 / SPEED));
  const give = h.kind === "question" ? 1700 : 1300;
  const back = run * 0.7;
  return { start, end, span, dir, run, give, back, total: HOP + run + give + back + FADE };
}
type Plan = ReturnType<typeof plan>;

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clamp = (t: number) => Math.max(0, Math.min(1, t));

/** Where the runner is t ms into a run. */
function pose(p: Plan, t: number) {
  const tRun = t - HOP;
  const tGive = tRun - p.run;
  const tBack = tGive - p.give;
  const tFade = tBack - p.back;
  const phase = tRun < 0 ? "hop" : tGive < 0 ? "run" : tBack < 0 ? "give" : tFade < 0 ? "back" : "fade";
  const deg =
    phase === "run"
      ? p.start + p.span * ease(tRun / p.run)
      : phase === "give"
        ? p.end
        : phase === "back"
          ? p.end - p.span * ease(tBack / p.back)
          : phase === "fade" && p.back === 0
            ? p.end
            : p.start;
  return { phase, deg, tRun, tGive, tBack, tFade };
}

/* ------------------------------------------------------------------ component */

export function HandoffRunner({
  handoffs,
  seats,
  center,
  radius,
  hidden,
  onPass,
  onArrive,
  onRunner,
}: {
  handoffs: Handoff[];
  seats: Record<OrbitNodeId, Seat>;
  center: { x: number; y: number };
  radius: number;
  hidden: boolean;
  /** A broadcast runner went past this seat. */
  onPass?: (node: OrbitNodeId) => void;
  /** The runner reached the receiver. */
  onArrive?: (h: Handoff) => void;
  /** Which employee is out running right now, or null. */
  onRunner?: (node: OrbitNodeId | null) => void;
}) {
  const [since] = useState(() => Date.now() - 30_000);
  const [played, setPlayed] = useState<number[]>([]);
  const [current, setCurrent] = useState<{ id: number; at: number } | null>(null);
  const [now, setNow] = useState(0);
  const queue = useRef<number[]>([]);
  const busy = useRef(false);

  const h = current ? handoffs.find((x) => x.id === current.id) : undefined;
  const p = h ? plan(h, seats, radius) : null;
  const live = useRef<{ h?: Handoff; p: Plan | null; onPass?: typeof onPass; onArrive?: typeof onArrive; onRunner?: typeof onRunner; handoffs: Handoff[]; seats: typeof seats }>({
    p: null,
    handoffs,
    seats,
  });
  useEffect(() => {
    live.current = { h, p, onPass, onArrive, onRunner, handoffs, seats };
  });

  // Starts the next queued run. Only called from callbacks.
  const next = useRef(() => {});
  useEffect(() => {
    next.current = () => {
      const id = queue.current.shift();
      if (id === undefined) {
        busy.current = false;
        setCurrent(null);
        live.current.onRunner?.(null);
        return;
      }
      busy.current = true;
      const at = performance.now();
      setNow(at);
      setCurrent({ id, at });
      live.current.onRunner?.(live.current.handoffs.find((x) => x.id === id)?.from ?? null);
    };
  }, []);
  const enqueue = (ids: number[]) => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    queue.current.push(...ids.filter((id) => !queue.current.includes(id) && !(busy.current && current?.id === id)));
    if (!busy.current) next.current();
  };
  const enqueueRef = useRef(enqueue);
  useEffect(() => {
    enqueueRef.current = enqueue;
  });

  // Fresh hand-offs play once, in order.
  const freshKey = handoffs
    .filter((x) => Date.parse(x.createdAt) > since && !played.includes(x.id))
    .map((x) => x.id)
    .join(",");
  useEffect(() => {
    if (!freshKey) return;
    const ids = freshKey.split(",").map(Number);
    const raf = requestAnimationFrame(() => {
      setPlayed((list) => [...list, ...ids]);
      enqueueRef.current(ids);
    });
    return () => cancelAnimationFrame(raf);
  }, [freshKey]);

  useEffect(() => {
    if (!current) return;
    let raf = 0;
    let lastDeg: number | null = null;
    let arrived = false;
    const tick = (t: number) => {
      const { h: run, p: pl, onPass: pass, onArrive: arrive, seats: s } = live.current;
      // A run whose hand-off is gone (the task changed) ends here.
      if (!run || !pl || t - current.at >= pl.total) {
        next.current();
        return;
      }
      const at = pose(pl, t - current.at);
      if (run.kind === "broadcast" && at.phase === "run" && pass) {
        const prev = lastDeg ?? pl.start;
        for (const [id, seat] of Object.entries(s) as [OrbitNodeId, Seat][]) {
          if (id === run.from) continue;
          // Seat angles unwrapped to the run's range.
          const target = seat.angle + 360 * Math.ceil((pl.start - seat.angle) / 360);
          if (target > prev && target <= at.deg) pass(id);
        }
        lastDeg = at.deg;
      }
      if (!arrived && at.phase === "give") {
        arrived = true;
        arrive?.(run);
      }
      setNow(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [current]);

  const pt = (deg: number, r = radius) => {
    const a = (deg * Math.PI) / 180;
    return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
  };


  let scene: React.ReactNode = null;
  if (h && p && current && !hidden) {
    const t = now - current.at;
    const { phase, deg, tRun, tGive, tBack, tFade } = pose(p, t);
    const broadcast = h.kind === "broadcast";

    // Moving toward the receiver on "run", away on "back".
    const moving = phase === "run" || phase === "back";
    const sweep = phase === "back" ? -p.dir : p.dir;
    const dx = -Math.sin((deg * Math.PI) / 180) * sweep;
    const facingLeft = dx < 0;
    const here = pt(deg);
    const seatFrom = pt(seats[h.from].angle);
    const seatTo = pt(seats[h.to].angle);

    const scale = phase === "hop" ? 0.5 + 0.5 * clamp(t / HOP) : phase === "fade" ? 1 - 0.5 * clamp(tFade / FADE) : 1;
    const opacity = phase === "hop" ? clamp(t / (HOP * 0.6)) : phase === "fade" ? 1 - clamp(tFade / FADE) : 1;
    const pos = phase === "hop" ? { x: seatFrom.x + (here.x - seatFrom.x) * clamp(t / HOP), y: seatFrom.y + (here.y - seatFrom.y) * clamp(t / HOP) } : here;
    // A short hop on the way out of the seat, and a jump over any seat it passes.
    const near = Math.min(
      ...Object.entries(seats)
        .filter(([id]) => id !== h.from && id !== h.to)
        .map(([, s]) => Math.abs(((deg - s.angle + 540) % 360) - 180)),
    );
    const lift = phase === "hop" ? Math.sin(Math.PI * clamp(t / HOP)) * 22 : moving && near < JUMP ? Math.cos((near / JUMP) * (Math.PI / 2)) * 46 : 0;

    // The note rides above the runner, then flies into the receiver's seat.
    const giveT = phase === "give" && !broadcast ? clamp(tGive / 520) : 0;
    const noteVisible = phase === "hop" || phase === "run" || (phase === "give" && !broadcast && giveT < 1);
    const headY = pos.y - SIZE - lift - 10;
    const note =
      phase === "give"
        ? { x: pos.x + (seatTo.x - pos.x) * ease(giveT), y: headY + (seatTo.y - 20 - headY) * ease(giveT) - Math.sin(Math.PI * giveT) * 40, s: 1 - 0.75 * giveT }
        : { x: pos.x, y: headY, s: phase === "hop" ? clamp(t / HOP) : 1 };
    const reply = !broadcast && phase === "give" && tGive > 480 ? (h.kind === "question" ? "Hmm, let me look" : "Got it") : null;
    const Prop = broadcast ? ScrollText : Mail;

    // Dust puffs behind the feet while running.
    const puffs = moving
      ? [90, 180, 270].map((lag, i) => {
          const tt = phase === "run" ? tRun - lag : tBack - lag;
          const len = phase === "run" ? p.run : p.back;
          if (tt < 0) return null;
          const d = phase === "run" ? p.start + p.span * ease(clamp(tt / len)) : p.end - p.span * ease(clamp(tt / len));
          const q = pt(d);
          return <span key={i} className="absolute size-1.5 rounded-[1px] bg-zinc-300" style={{ left: q.x - 3, top: q.y - 4, opacity: 0.7 - i * 0.22 }} />;
        })
      : null;

    scene = (
      <>
        {puffs}
        <div className="absolute" style={{ left: pos.x - SIZE / 2, top: pos.y - SIZE - lift, width: SIZE, height: SIZE, opacity, transform: "scale(" + scale + ")", transformOrigin: "50% 100%" }}>
          <div className={cn(moving && "px-run")} style={{ transform: facingLeft ? "scaleX(-1)" : undefined }}>
            <PixelAgent actorId={seats[h.from].actorId} size={SIZE} working={moving} />
          </div>
          {phase === "back" || (phase === "fade" && !broadcast) ? null : (
            <Prop className="absolute -right-2.5 top-[26px] size-5 rounded-[3px] bg-white text-brand-ink" strokeWidth={2.25} />
          )}
          {h.kind === "question" && (phase === "run" || phase === "hop") ? (
            <span className="absolute -top-1 -left-3 font-mono text-[18px] leading-none font-bold text-zinc-900">?</span>
          ) : null}
        </div>
        {noteVisible ? (
          <div
            className="absolute w-max max-w-[300px] rounded-xl bg-white px-3 py-2 shadow-[0_2px_12px_rgb(0_0_0/0.14)] ring-1 ring-zinc-200"
            style={{ left: note.x, top: note.y, transform: "translate(-50%, -100%) scale(" + note.s + ")", transformOrigin: "50% 100%" }}
          >
            <div className="flex items-center gap-1.5 text-[16px] font-medium text-zinc-900">
              <Prop className="size-4 shrink-0 text-brand-ink" />
              <span className="truncate">{h.label}</span>
            </div>
            {h.detail ? <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-zinc-500">{h.detail}</div> : null}
            <div className="mt-1 font-mono text-[11px] tracking-wide text-zinc-400 uppercase">{broadcast ? "To everyone" : "To " + seats[h.to].label}</div>
          </div>
        ) : null}
        {reply ? (
          <div
            className="orbit-spawn absolute rounded-lg bg-zinc-900 px-2.5 py-1 text-[15px] font-medium whitespace-nowrap text-white"
            style={{ left: seatTo.x, top: seatTo.y - 48, transform: "translate(-50%, -100%)" }}
          >
            {reply}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-30">
      {scene}
    </div>
  );
}
