"use client";

/*
 * Pixel meadow art, shared by the landing page and the intro dialog. Drawn on a
 * small pixel grid and scaled up with crisp edges; positions come from a seeded
 * random, so server and browser agree.
 */

const W = 192;
const H = 108;
const HORIZON = 30;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Px = { x: number; y: number; c: string };

export const FLOWER_COLORS = [
  { petal: "#fffaf0", eye: "#f5c518" },
  { petal: "#ffd84d", eye: "#e58a1f" },
  { petal: "#ff9fc0", eye: "#fff1a6" },
  { petal: "#c9b6ff", eye: "#fff1a6" },
];

/** Flowers that read on a white card (the white daisy only works on grass). */
export const UI_FLOWERS = {
  yellow: FLOWER_COLORS[1],
  pink: FLOWER_COLORS[2],
  purple: FLOWER_COLORS[3],
  peach: { petal: "#ffb38a", eye: "#fff1a6" },
  green: { petal: "#7cc95d", eye: "#fff1a6" },
};

/** Grass tufts and flowers, larger toward the front. */
function meadow() {
  const r = rng(7);
  const grass: Px[] = [];
  for (let i = 0; i < 520; i++) {
    const y = HORIZON + 2 + Math.floor(r() * (H - HORIZON - 2));
    const x = Math.floor(r() * W);
    grass.push({ x, y, c: r() < 0.5 ? "#4f9e3c" : "#7cc95d" });
    if (y > 60 && r() < 0.5) grass.push({ x, y: y - 1, c: "#4f9e3c" });
  }
  const flowers: { x: number; y: number; big: boolean; petal: string; eye: string; d: number }[] = [];
  for (let i = 0; i < 110; i++) {
    const y = HORIZON + 4 + Math.floor(r() * (H - HORIZON - 6));
    const x = 2 + Math.floor(r() * (W - 4));
    const col = FLOWER_COLORS[Math.floor(r() * FLOWER_COLORS.length)];
    // Leave a clearing behind the title, subtitle and button.
    if (x > 58 && x < 134 && y < 84) continue;
    flowers.push({ x, y, big: y > 64, ...col, d: Math.round(r() * 30) / 10 });
  }
  flowers.sort((a, b) => a.y - b.y);
  return { grass, flowers };
}

const FIELD = meadow();

/** A cloud as a few stacked runs of white pixels. */
function Cloud({ x, y, drift }: { x: number; y: number; drift: string }) {
  return (
    <g className={drift}>
      <rect x={x + 3} y={y} width={6} height={1} fill="#ffffff" />
      <rect x={x + 1} y={y + 1} width={11} height={1} fill="#ffffff" />
      <rect x={x} y={y + 2} width={15} height={2} fill="#ffffff" />
      <rect x={x} y={y + 4} width={15} height={1} fill="#e3f1fb" />
    </g>
  );
}

const HILLS = [
  [0, 26, 40],
  [36, 24, 30],
  [62, 27, 44],
  [100, 23, 36],
  [132, 26, 30],
  [158, 24, 40],
];

/** The full meadow: sky, sun, clouds, hills, grass and flowers. */
export function Field() {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" shapeRendering="crispEdges" className="absolute inset-0 size-full" aria-hidden>
      {/* sky, in hard bands */}
      <rect x={0} y={0} width={W} height={HORIZON} fill="#8fd0f2" />
      <rect x={0} y={HORIZON - 10} width={W} height={10} fill="#a9dcf5" />
      <rect x={0} y={HORIZON - 4} width={W} height={4} fill="#c3e8f8" />
      {/* sun */}
      <rect x={159} y={6} width={10} height={6} fill="#ffe680" />
      <rect x={160} y={5} width={8} height={8} fill="#ffe680" />
      <rect x={161} y={6} width={6} height={6} fill="#fff4b8" />
      <Cloud x={14} y={6} drift="pxl-drift-a" />
      <Cloud x={70} y={12} drift="pxl-drift-b" />
      <Cloud x={118} y={4} drift="pxl-drift-a" />
      {/* far hills, stepped */}
      {HILLS.map(([x, y, w]) => (
        <g key={x}>
          <rect x={x} y={y} width={w} height={HORIZON - y + 1} fill="#6fb85a" />
          <rect x={x + 3} y={y - 1} width={w - 6} height={1} fill="#6fb85a" />
          <rect x={x + 8} y={y - 2} width={w - 16} height={1} fill="#6fb85a" />
        </g>
      ))}
      {/* the meadow */}
      <rect x={0} y={HORIZON} width={W} height={H - HORIZON} fill="#62b34c" />
      <rect x={0} y={HORIZON} width={W} height={2} fill="#57a843" />
      <rect x={0} y={H - 22} width={W} height={22} fill="#5aac45" />
      {FIELD.grass.map((g, i) => (
        <rect key={i} x={g.x} y={g.y} width={1} height={1} fill={g.c} />
      ))}
      {FIELD.flowers.map((f, i) =>
        f.big ? (
          <g key={i} className="pxl-sway" style={{ animationDelay: f.d + "s" }}>
            <rect x={f.x} y={f.y + 2} width={1} height={3} fill="#3f8a2f" />
            <rect x={f.x + 1} y={f.y + 3} width={1} height={1} fill="#3f8a2f" />
            <rect x={f.x - 1} y={f.y} width={3} height={1} fill={f.petal} />
            <rect x={f.x} y={f.y - 1} width={1} height={3} fill={f.petal} />
            <rect x={f.x} y={f.y} width={1} height={1} fill={f.eye} />
          </g>
        ) : (
          <g key={i}>
            <rect x={f.x} y={f.y + 1} width={1} height={1} fill="#3f8a2f" />
            <rect x={f.x} y={f.y} width={1} height={1} fill={f.petal} />
          </g>
        ),
      )}
    </svg>
  );
}


/** One pixel flower, inline (a list bullet, a badge). */
export function Flower({ petal, eye, size = 20, className }: { petal: string; eye: string; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 5 7" width={size} height={(size * 7) / 5} shapeRendering="crispEdges" aria-hidden className={className}>
      <rect x={2} y={4} width={1} height={3} fill="#3f8a2f" />
      <rect x={3} y={5} width={1} height={1} fill="#3f8a2f" />
      <rect x={1} y={4} width={1} height={1} fill="#3f8a2f" />
      <rect x={0} y={1} width={5} height={1} fill={petal} />
      <rect x={1} y={0} width={3} height={3} fill={petal} />
      <rect x={2} y={1} width={1} height={1} fill={eye} />
    </svg>
  );
}

/** A thin strip of meadow: grass, a few flowers, for the top of a card. */
export function MeadowStrip({ seed = 3, className }: { seed?: number; className?: string }) {
  const r = rng(seed);
  const specks = Array.from({ length: 70 }, () => ({ x: Math.floor(r() * 96), y: 4 + Math.floor(r() * 12), c: r() < 0.5 ? "#4f9e3c" : "#7cc95d" }));
  const blooms = Array.from({ length: 12 }, () => ({ x: 2 + Math.floor(r() * 92), y: 6 + Math.floor(r() * 8), ...FLOWER_COLORS[Math.floor(r() * FLOWER_COLORS.length)] }));
  return (
    <svg viewBox="0 0 96 16" preserveAspectRatio="xMidYMax slice" shapeRendering="crispEdges" aria-hidden className={className}>
      <rect x={0} y={0} width={96} height={16} fill="#8fd0f2" />
      <rect x={0} y={0} width={96} height={4} fill="#a9dcf5" />
      <rect x={70} y={1} width={4} height={3} fill="#ffe680" />
      <rect x={0} y={4} width={96} height={12} fill="#62b34c" />
      <rect x={0} y={4} width={96} height={1} fill="#57a843" />
      {specks.map((g, i) => (
        <rect key={i} x={g.x} y={g.y} width={1} height={1} fill={g.c} />
      ))}
      {blooms.map((f, i) => (
        <g key={i}>
          <rect x={f.x} y={f.y + 1} width={1} height={2} fill="#3f8a2f" />
          <rect x={f.x - 1} y={f.y} width={3} height={1} fill={f.petal} />
          <rect x={f.x} y={f.y - 1} width={1} height={3} fill={f.petal} />
          <rect x={f.x} y={f.y} width={1} height={1} fill={f.eye} />
        </g>
      ))}
    </svg>
  );
}
