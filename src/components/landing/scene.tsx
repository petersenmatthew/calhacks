"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { PixelAgent } from "../pixel-agent";

/*
 * The landing scene: a soft pixel meadow on a 320 x 180 grid (scaled up with
 * crisp edges, anchored to the bottom so the field always fills the lower part
 * of the screen), with the team wandering around in it.
 */

const W = 320;
const H = 180;
/** Where the meadow meets the hills, in grid rows. */
const FIELD_TOP = 108;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A stepped silhouette: column heights from a few sine waves, in blocks of `step` pixels. */
function ridge(base: number, amp: number, seed: number, step = 4) {
  const cols: { x: number; y: number }[] = [];
  for (let x = 0; x < W; x += step) {
    const t = x / W;
    const y = base - amp * (0.55 * Math.sin(t * 6.1 + seed) + 0.3 * Math.sin(t * 13.7 + seed * 2) + 0.15 * Math.sin(t * 29 + seed * 3));
    cols.push({ x, y: Math.round(y) });
  }
  return cols;
}

/** Rows of a two-colour checkerboard: the dithered band between two tones. */
function Dither({ y, h, a, b }: { y: number; h: number; a: string; b: string }) {
  const id = "d" + y + a.slice(1) + b.slice(1);
  return (
    <>
      <defs>
        <pattern id={id} width={2} height={2} patternUnits="userSpaceOnUse">
          <rect width={2} height={2} fill={a} />
          <rect width={1} height={1} fill={b} />
          <rect x={1} y={1} width={1} height={1} fill={b} />
        </pattern>
      </defs>
      <rect x={0} y={y} width={W} height={h} fill={`url(#${id})`} />
    </>
  );
}

/** A soft cumulus: stacked runs, widest at the base, with a shaded underside. */
function Cloud({ x, y, w, className }: { x: number; y: number; w: number; className?: string }) {
  const rows = [0.35, 0.6, 0.8, 0.92, 1, 1, 1];
  return (
    <g className={className}>
      {rows.map((f, i) => {
        const rw = Math.round(w * f);
        return <rect key={i} x={x + Math.round((w - rw) / 2) + (i < 3 ? Math.round(w * 0.12) : 0)} y={y + i * 2} width={rw} height={2} fill={i === rows.length - 1 ? "#d6effa" : "#f4fbff"} />;
      })}
    </g>
  );
}

/** A round pixel tree clump. */
function Tree({ x, y, r }: { x: number; y: number; r: number }) {
  const rows = [];
  for (let dy = -r; dy <= 0; dy++) {
    const half = Math.round(Math.sqrt(r * r - dy * dy));
    rows.push(<rect key={dy} x={x - half} y={y + dy} width={half * 2} height={1} fill={dy < -r / 2 ? "#4f9f3c" : "#3f8b31"} />);
  }
  return <g>{rows}</g>;
}

/** A wheat stalk with its leaves, swaying from the base. */
function Wheat({ x, h, delay = 0 }: { x: number; h: number; delay?: number }) {
  const base = H;
  const top = base - h;
  const grains = [];
  for (let i = 0; i < 6; i++) {
    const gy = top + i * 3;
    grains.push(<rect key={"l" + i} x={x - 2} y={gy + 1} width={2} height={2} fill={i % 2 ? "#e5a83f" : "#f0c55c"} />);
    grains.push(<rect key={"r" + i} x={x + 1} y={gy} width={2} height={2} fill={i % 2 ? "#f0c55c" : "#e5a83f"} />);
  }
  return (
    <g className="pxl-wheat" style={{ animationDelay: delay + "s" }}>
      <rect x={x} y={top + 2} width={1} height={h - 2} fill="#c99a45" />
      {grains}
      <rect x={x} y={top - 1} width={1} height={2} fill="#f0c55c" />
    </g>
  );
}

const FAR = ridge(92, 9, 1.3);
const MID = ridge(100, 6, 4.1);

const R = rng(11);
const SPECKS = Array.from({ length: 900 }, () => {
  const y = FIELD_TOP + 2 + Math.floor(R() * (H - FIELD_TOP - 2));
  return { x: Math.floor(R() * W), y, c: R() < 0.5 ? "#b1e163" : "#6cb53a", tall: y > 150 && R() < 0.6 };
});
const BLOOMS = Array.from({ length: 46 }, () => ({
  x: Math.floor(R() * W),
  y: FIELD_TOP + 6 + Math.floor(R() * (H - FIELD_TOP - 10)),
  c: ["#fffaf0", "#ffd95c", "#ff9fbd", "#c3aeff"][Math.floor(R() * 4)],
}));
const TREES = [
  { x: 20, y: 110, r: 9 },
  { x: 33, y: 110, r: 6 },
  { x: 236, y: 109, r: 7 },
  { x: 288, y: 110, r: 10 },
  { x: 302, y: 110, r: 7 },
];

export function MeadowScene() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" shapeRendering="crispEdges" className="absolute inset-0 size-full" aria-hidden>
      {/* sky: bands from deep to pale, dithered where they meet */}
      <rect x={0} y={0} width={W} height={H} fill="#45b4ee" />
      <Dither y={22} h={6} a="#45b4ee" b="#5fc1f1" />
      <rect x={0} y={28} width={W} height={34} fill="#5fc1f1" />
      <Dither y={62} h={6} a="#5fc1f1" b="#7fcdf3" />
      <rect x={0} y={68} width={W} height={20} fill="#7fcdf3" />
      <Dither y={88} h={4} a="#7fcdf3" b="#a3dbf6" />
      <rect x={0} y={92} width={W} height={20} fill="#a3dbf6" />

      <Cloud x={-14} y={64} w={62} className="pxl-cloud-a" />
      <Cloud x={232} y={58} w={84} className="pxl-cloud-b" />
      <Cloud x={168} y={4} w={28} className="pxl-cloud-a" />
      <Cloud x={34} y={16} w={36} className="pxl-cloud-b" />

      {/* birds crossing the sky */}
      <g className="pxl-birds">
        <g className="pxl-flap">
          <rect x={60} y={40} width={1} height={1} fill="#3d5a6c" />
          <rect x={61} y={41} width={1} height={1} fill="#3d5a6c" />
          <rect x={62} y={40} width={1} height={1} fill="#3d5a6c" />
        </g>
        <g className="pxl-flap" style={{ animationDelay: "0.2s" }}>
          <rect x={68} y={44} width={1} height={1} fill="#3d5a6c" />
          <rect x={69} y={45} width={1} height={1} fill="#3d5a6c" />
          <rect x={70} y={44} width={1} height={1} fill="#3d5a6c" />
        </g>
      </g>

      {/* far mountains, then nearer hills */}
      {FAR.map((c) => (
        <rect key={"f" + c.x} x={c.x} y={c.y} width={4} height={H - c.y} fill="#76c0aa" />
      ))}
      {MID.map((c) => (
        <rect key={"m" + c.x} x={c.x} y={c.y} width={4} height={H - c.y} fill="#5fb377" />
      ))}
      <rect x={0} y={104} width={W} height={6} fill="#78c24c" />
      {TREES.map((t) => (
        <Tree key={t.x} {...t} />
      ))}

      {/* the meadow, light at the back and richer toward you */}
      <rect x={0} y={FIELD_TOP} width={W} height={H - FIELD_TOP} fill="#9bd551" />
      <Dither y={FIELD_TOP + 14} h={4} a="#9bd551" b="#8acb43" />
      <rect x={0} y={FIELD_TOP + 18} width={W} height={H} fill="#8acb43" />
      <Dither y={FIELD_TOP + 38} h={4} a="#8acb43" b="#7bbf38" />
      <rect x={0} y={FIELD_TOP + 42} width={W} height={H} fill="#7bbf38" />
      {SPECKS.map((s, i) => (
        <rect key={i} x={s.x} y={s.tall ? s.y - 1 : s.y} width={1} height={s.tall ? 2 : 1} fill={s.c} />
      ))}
      {BLOOMS.map((b, i) => (
        <rect key={i} x={b.x} y={b.y} width={1} height={1} fill={b.c} />
      ))}
      {/* nearer flowers get petals */}
      {BLOOMS.filter((b) => b.y > 146).map((b, i) => (
        <g key={"n" + i}>
          <rect x={b.x - 1} y={b.y} width={3} height={1} fill={b.c} />
          <rect x={b.x} y={b.y - 1} width={1} height={3} fill={b.c} />
          <rect x={b.x} y={b.y} width={1} height={1} fill="#f2b33d" />
        </g>
      ))}

      {/* foreground: leaves and wheat at both edges */}
      <Wheat x={14} h={34} delay={0} />
      <Wheat x={24} h={26} delay={0.6} />
      <Wheat x={292} h={30} delay={0.3} />
      <Wheat x={306} h={22} delay={0.9} />
    </svg>
  );
}

const CREW = ["agent.capacity", "agent.compute", "agent.finance", "you", "agent.vendor", "agent.budget", "agent.policy"] as const;

type Walker = { x: number; y: number; dur: number; left: boolean; moving: boolean };

/** Where people may stand, as % of the screen: inside the meadow, clear of the edges. */
const ZONE = { x0: 8, x1: 92, y0: 72, y1: 92 };

function start(i: number): Walker {
  const x = ZONE.x0 + ((i + 0.5) / CREW.length) * (ZONE.x1 - ZONE.x0);
  const y = ZONE.y0 + ((i * 37) % 100) / 100 * (ZONE.y1 - ZONE.y0);
  return { x, y, dur: 0, left: false, moving: false };
}

/** The team, wandering: each walks to a random spot, stops a while, and picks another. */
export function Roamers() {
  const [walkers, setWalkers] = useState<Walker[]>(() => CREW.map((_, i) => start(i)));
  const timers = useRef<number[]>([]);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const list = timers.current;
    const step = (i: number) => {
      setWalkers((all) => {
        const w = all[i];
        if (w.moving) {
          const next = all.slice();
          next[i] = { ...w, moving: false };
          list[i] = window.setTimeout(() => step(i), 1200 + Math.random() * 3200);
          return next;
        }
        const x = ZONE.x0 + Math.random() * (ZONE.x1 - ZONE.x0);
        const y = ZONE.y0 + Math.random() * (ZONE.y1 - ZONE.y0);
        const dist = Math.hypot(x - w.x, (y - w.y) * 2);
        const dur = Math.max(1.6, dist / 4.5);
        const next = all.slice();
        next[i] = { x, y, dur, left: x < w.x, moving: true };
        list[i] = window.setTimeout(() => step(i), dur * 1000);
        return next;
      });
    };
    CREW.forEach((_, i) => {
      list[i] = window.setTimeout(() => step(i), 400 + i * 450);
    });
    return () => list.forEach((t) => window.clearTimeout(t));
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {walkers.map((w, i) => {
        const id = CREW[i];
        // Further back is smaller.
        const depth = (w.y - ZONE.y0) / (ZONE.y1 - ZONE.y0);
        const size = (id === "you" ? 56 : 44) * (0.78 + depth * 0.32);
        return (
          <div
            key={id}
            className="absolute"
            style={{
              left: w.x + "%",
              top: w.y + "%",
              zIndex: Math.round(w.y),
              transform: "translate(-50%, -100%)",
              transition: `left ${w.dur}s linear, top ${w.dur}s linear`,
            }}
          >
            <div className={cn(w.moving && "px-run")} style={{ transform: w.left ? "scaleX(-1)" : undefined }}>
              <PixelAgent actorId={id} size={Math.round(size)} working={w.moving} className="h-auto" />
            </div>
            {/* a soft shadow under the feet */}
            <div className="mx-auto -mt-1 h-1.5 rounded-full bg-[#4f8a3a]/25" style={{ width: size * 0.6 }} />
          </div>
        );
      })}
    </div>
  );
}
