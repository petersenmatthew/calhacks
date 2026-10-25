"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, LoaderCircle, Minus, ScrollText, X } from "lucide-react";
import { PixelAgent } from "../pixel-agent";
import type { BurnSpec, Check as CheckRow, ContractPreview, PolicyChange, SplitPart, DocSpec, FrameSpec, MatchSpec, StackSpec, ThreadSpec, TimelineSpec, Tone } from "@/lib/frames";
import { CONTRACT_ID, contractHref, contractThumb } from "@/lib/contracts";
import { ContractLinked } from "../contract/contract-link";
import { compactMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { postJson } from "@/lib/api";
import { toast } from "sonner";

/** Frames are laid out at this size, then scaled into the small card on the canvas. */
export const DW = 640;
export const DH = 480;

type Timeline = {
  doc: number;
  lanes: number[];
  match: number[];
  result: number;
  stack: number;
  legend: number[];
  burn: [number, number];
  steps: number[];
  messages: number[];
  query?: [number, number];
  rows: number[];
  bars: number[];
  ledger: number[];
  balance: number;
  draftHead: number;
  draftBody?: [number, number];
  checks: number[];
  summary: number;
  /** The contract card scrolls through the PDF over this span, then settles on the cited page. */
  contract?: [number, number];
  total: number;
};

const RESOLVE_MS = 260;

/** How long a frame takes to build itself from blank to finished. */
export function buildTime(spec: FrameSpec) {
  return timeline(spec).total;
}

function timeline(spec: FrameSpec): Timeline {
  let t = 200;
  const tl: Timeline = {
    doc: 0,
    lanes: [],
    match: [],
    result: 0,
    stack: 0,
    legend: [],
    burn: [0, 0],
    steps: [],
    messages: [],
    rows: [],
    bars: [],
    ledger: [],
    balance: 0,
    draftHead: 0,
    checks: [],
    summary: 0,
    total: 0,
  };
  const each = (count: number, gap: number, into: number[]) => {
    for (let i = 0; i < count; i++) {
      into.push(t);
      t += gap;
    }
  };
  if (spec.doc) {
    tl.doc = t;
    t += 700;
  }
  if (spec.timeline) {
    each(spec.timeline.lanes.length, 420, tl.lanes);
    t += 300;
  }
  if (spec.match) {
    const start = t;
    each(spec.match.rows.length + 1, 300, tl.match);
    // The contract scrolls while the rows fill in; the verdict lands once it reaches the cited page.
    if (spec.contract?.page) {
      tl.contract = [start, 900 + spec.contract.page.of * 450];
      t = Math.max(t, start + tl.contract[1]);
    }
    tl.result = t;
    t += 400;
  }
  if (spec.stack) {
    tl.stack = t;
    t += 700;
    each(spec.stack.parts.length, 160, tl.legend);
  }
  if (spec.burn) {
    tl.burn = [t, 1400];
    t += 1600;
  }
  if (spec.thread) {
    each(spec.thread.steps.length, 220, tl.steps);
    each(spec.thread.messages.length, 500, tl.messages);
  }
  if (spec.query) {
    const d = Math.min(1500, spec.query.text.length * 14);
    tl.query = [t, d];
    t += d + 220;
  }
  each(spec.table?.rows.length ?? 0, 130, tl.rows);
  if (spec.table) t += 150;
  each(spec.bars?.length ?? 0, 300, tl.bars);
  if (spec.ledger) {
    each(spec.ledger.lines.length, 240, tl.ledger);
    tl.balance = t;
    t += 320;
  }
  if (spec.draft) {
    tl.draftHead = t;
    t += 260;
    const d = Math.min(2800, spec.draft.body.length * 11);
    tl.draftBody = [t, d];
    t += d + 220;
  }
  each(spec.checks?.length ?? 0, 360, tl.checks);
  tl.summary = t;
  t += 300;
  if (spec.contract?.page && !tl.contract) {
    tl.contract = [t, 700 + spec.contract.page.of * 450];
    t += tl.contract[1];
  }
  tl.total = t + 200;
  return tl;
}

/** Milliseconds since playback started; Infinity shows the finished frame. */
function useElapsed(play: boolean, delay: number, total: number) {
  const [t, setT] = useState(play ? -delay : Infinity);
  useEffect(() => {
    if (!play) return;
    let raf = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const e = now - start;
      if (e >= total) {
        setT(Infinity);
        return;
      }
      setT(e);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [play, delay, total]);
  return t;
}

function typed(text: string, t: number, span?: [number, number]) {
  if (!span) return text;
  const [start, dur] = span;
  if (t >= start + dur) return text;
  if (t <= start) return "";
  return text.slice(0, Math.floor(((t - start) / dur) * text.length));
}

const SQL_WORDS = /\b(SELECT|FROM|WHERE|JOIN|ON|AND|AS|ORDER BY|GROUP BY|LIMIT|MATCH|SUM)\b|('[^']*'?)/g;

function Highlight({ text, lang }: { text: string; lang: "sql" | "json" | "call" }) {
  if (lang === "json") {
    return (
      <>
        {text.split(/("[^"]*"\s*:)/g).map((part, i) =>
          part.endsWith(":") ? (
            <span key={i} className="text-zinc-400">
              {part}
            </span>
          ) : (
            <span key={i} className="text-[#c4ebb2]">
              {part}
            </span>
          ),
        )}
      </>
    );
  }
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(SQL_WORDS)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span key={m.index} className={m[2] ? "text-[#c4ebb2]" : "text-[#7cc95d]"}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

function Caret({ on }: { on: boolean }) {
  if (!on) return null;
  return <span className="ml-0.5 inline-block h-[1.05em] w-[0.5em] translate-y-[0.15em] animate-pulse bg-current" />;
}

function CheckIcon({ ok, resolving }: { ok?: boolean; resolving: boolean }) {
  const box = "grid size-6 shrink-0 place-items-center rounded-full";
  if (resolving) return <span className={cn(box, "bg-zinc-100 text-zinc-500")}><LoaderCircle className="size-3.5 animate-spin" /></span>;
  if (ok === true) return <span className={cn(box, "bg-accent text-brand-ink")}><Check className="size-3.5" strokeWidth={3} /></span>;
  if (ok === false) return <span className={cn(box, "bg-red-50 text-destructive")}><X className="size-3.5" strokeWidth={3} /></span>;
  return <span className={cn(box, "bg-zinc-100 text-zinc-400")}><Minus className="size-3.5" /></span>;
}

function CheckList({ checks, at, t }: { checks: CheckRow[]; at: number[]; t: number }) {
  return (
    <ul className="mt-4 space-y-1.5">
      {checks.map((c, i) =>
        t >= at[i] ? (
          <li key={i} className="animate-enter flex items-start gap-3 rounded-lg bg-zinc-50 px-3 py-2 ring-1 ring-zinc-100">
            <CheckIcon ok={c.ok} resolving={t < at[i] + RESOLVE_MS} />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-zinc-800">{c.label}</div>
              {c.detail ? <div className="text-[12.5px] leading-snug text-zinc-500">{c.detail}</div> : null}
            </div>
          </li>
        ) : null,
      )}
    </ul>
  );
}

/* ------------------------------------------------------------- visuals */

const TONE_BG: Record<Tone, string> = { base: "bg-zinc-400", ok: "bg-primary", warn: "bg-amber-400", bad: "bg-red-500", muted: "bg-zinc-200" };
const TONE_PILL: Record<Tone, string> = {
  base: "bg-zinc-100 text-zinc-600",
  ok: "bg-accent text-brand-ink",
  warn: "bg-amber-50 text-amber-700",
  bad: "bg-red-50 text-destructive",
  muted: "bg-zinc-100 text-zinc-500",
};
const TONE_STROKE: Record<Tone, string> = { base: "#71717a", ok: "var(--brand-ink)", warn: "#d97706", bad: "var(--destructive)", muted: "#a1a1aa" };

/** 0 to 1 progress of an animation that starts at `start`. Finished frames (t = Infinity) are at 1. */
const grow = (t: number, start: number, dur: number) => Math.min(1, Math.max(0, (t - start) / dur));

function DocView({ doc, at, t }: { doc: DocSpec; at: number; t: number }) {
  if (t < at) return null;
  return (
    <div className="animate-enter mt-4 rounded-xl bg-[#fbfbf9] p-4 ring-1 ring-zinc-200">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {doc.logo ? <img src={doc.logo} alt="" className="size-7 rounded-md object-cover" /> : null}
          <span className="text-[15px] font-semibold">{doc.vendor}</span>
        </div>
        <div className="text-right">
          <div className="font-mono text-[11px] tracking-widest text-zinc-400">INVOICE</div>
          <div className="font-mono text-[13px] text-zinc-700">{doc.number}</div>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-[64px_1fr] gap-y-0.5 text-[12.5px]">
        {doc.meta.map((m) => (
          <div key={m.label} className="contents">
            <dt className="text-zinc-400">{m.label}</dt>
            <dd className="truncate text-zinc-700">{m.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 overflow-hidden rounded-lg bg-white ring-1 ring-zinc-200">
        <div className="grid grid-cols-[1fr_88px_80px_100px] gap-2 bg-zinc-800 px-3 py-1.5 font-mono text-[10.5px] tracking-wider text-zinc-300 uppercase">
          <span>Description</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Rate</span>
          <span className="text-right">Amount</span>
        </div>
        <div className="grid grid-cols-[1fr_88px_80px_100px] gap-2 px-3 py-2 text-[13px]">
          <span className="truncate">{doc.line.description}</span>
          <span className="text-right tnum">{doc.line.qty}</span>
          <span className="text-right tnum">{doc.line.rate}</span>
          <span className="text-right tnum">{doc.line.amount}</span>
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-6 pr-3 text-[13px]">
        <span className="text-zinc-400">Total due</span>
        <span className="font-semibold tnum">{doc.line.amount}</span>
      </div>
    </div>
  );
}

const LANE_LABEL = 148;

function TimelineView({ spec, at, t }: { spec: TimelineSpec; at: number[]; t: number }) {
  const marksAt = (at.at(-1) ?? 0) + 500;
  return (
    <div className={cn("mt-4", spec.marks.length > 1 ? "pt-9" : "pt-5")}>
      <div className="relative">
        {spec.lanes.map((l, i) => {
          // Each lane fills left to right, in time order, so later spans never appear before earlier ones.
          const sweep = grow(t, at[i] + 100, 900);
          return t >= at[i] ? (
            <div key={l.key} className="animate-enter flex items-center gap-3 py-1.5">
              <div style={{ width: LANE_LABEL }} className="shrink-0">
                <div className="text-[13px] font-medium text-zinc-700">{l.label}</div>
                <div className={cn("text-[12px] tnum", l.tone === "bad" ? "text-destructive" : "text-zinc-500")}>{l.value}</div>
              </div>
              <div className="relative h-6 flex-1 rounded-md bg-zinc-50 ring-1 ring-zinc-100">
                {l.spans.map((s, j) =>
                  sweep > s.from ? (
                    <div
                      key={j}
                      className={cn("absolute inset-y-1 rounded-sm", TONE_BG[s.tone ?? l.tone])}
                      style={{ left: s.from * 100 + "%", width: Math.max(0.5, (Math.min(s.to, sweep) - s.from) * 100) + "%" }}
                    />
                  ) : null,
                )}
              </div>
            </div>
          ) : null;
        })}
        {t >= marksAt ? (
          <div className="pointer-events-none absolute inset-y-0 right-0" style={{ left: LANE_LABEL + 12 }}>
            {spec.marks.map((m, i) => (
              <div key={i} className="animate-enter absolute inset-y-0 border-l border-dashed border-zinc-500" style={{ left: m.at * 100 + "%" }}>
                <span
                  className={cn("absolute -translate-x-1/2 rounded px-1 text-[11px] whitespace-nowrap", m.tone === "ok" ? "bg-accent text-brand-ink" : "bg-zinc-800 text-white")}
                  style={{ top: -18 - (i % 2) * 18 }}
                >
                  {m.label}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="relative mt-1 h-4 text-[11px] text-zinc-400" style={{ marginLeft: LANE_LABEL + 12 }}>
        {spec.ticks.map((tk) => (
          <span key={tk.at} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: tk.at * 100 + "%" }}>
            {tk.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function MatchView({ m, at, result, t }: { m: MatchSpec; at: number[]; result: number; t: number }) {
  const deltaTone = (r: MatchSpec["rows"][number]): Tone => (r.tone === "ok" || r.tone === "muted" ? "base" : r.tone);
  return (
    <div className="mt-4 overflow-hidden rounded-xl ring-1 ring-zinc-200">
      {t >= at[0] ? (
        <div className="animate-enter flex items-center gap-3 bg-zinc-50 px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">{m.head.label}</div>
            <div className="truncate text-[12px] text-zinc-500">{m.head.detail}</div>
          </div>
          <div className="text-[16px] font-semibold tnum">{m.head.value}</div>
        </div>
      ) : null}
      {m.rows.map((r, i) =>
        t >= at[i + 1] ? (
          <div key={i} title={r.detail} className="animate-enter flex items-center gap-3 border-t px-4 py-1.5">
            <span className={cn("size-2 shrink-0 rounded-full", TONE_BG[r.tone])} />
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="shrink-0 text-[13.5px] text-zinc-800">{r.label}</span>
              {r.detail ? <span className="truncate text-[12px] text-zinc-400">{r.detail}</span> : null}
            </div>
            {r.delta ? <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] whitespace-nowrap tnum", TONE_PILL[deltaTone(r)])}>{r.delta}</span> : null}
            <span className="w-[88px] shrink-0 text-right text-[14px] tnum">{r.value}</span>
          </div>
        ) : null,
      )}
      {t >= result ? (
        <div className={cn("animate-enter flex items-center justify-between gap-3 px-4 py-2 text-[14px] font-semibold", TONE_PILL[m.result.tone])}>
          <span className="truncate">{m.result.label}</span>
          <span className="tnum">{m.result.value}</span>
        </div>
      ) : null}
    </div>
  );
}

const PALETTE = ["bg-primary", "bg-brand-ink", "bg-zinc-700", "bg-zinc-400", "bg-amber-400"];

function StackView({ s, at, legend, t }: { s: StackSpec; at: number; legend: number[]; t: number }) {
  let next = 0;
  const colors = s.parts.map((p) => (p.tone === "muted" ? "bg-zinc-200" : PALETTE[next++ % PALETTE.length]));
  const sum = s.parts.reduce((a, p) => a + p.share, 0) || 1;
  const g = grow(t, at, 700);
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] tracking-wider text-zinc-400 uppercase">Split</span>
        <span className="text-[13px] text-zinc-600 tnum">{s.total}</span>
      </div>
      <div className="mt-1.5 flex h-8 overflow-hidden rounded-lg bg-zinc-100">
        {s.parts.map((p, i) => (
          <div key={i} className={cn("h-full border-r-2 border-white last:border-r-0", colors[i])} style={{ width: (p.share / sum) * 100 * g + "%" }} />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5">
        {s.parts.map((p, i) =>
          t >= legend[i] ? (
            <li key={i} className="animate-enter flex items-center gap-2.5 text-[13px]">
              <span className={cn("size-2.5 shrink-0 rounded-sm", colors[i])} />
              <span className="min-w-0 flex-1 truncate text-zinc-700">{p.label}</span>
              <span className="w-12 text-right text-zinc-400 tnum">{Math.round(p.share * 100)}%</span>
              <span className="w-[120px] text-right text-zinc-800 tnum">{p.display}</span>
            </li>
          ) : null,
        )}
      </ul>
    </div>
  );
}

function BurnView({ b, span, t }: { b: BurnSpec; span: [number, number]; t: number }) {
  const w = 584;
  const h = 210;
  const L = 8;
  const R = 8;
  const T = 18;
  const B = 22;
  const used = b.used ?? b.posted;
  // Older runs have no daily series; fall back to a straight line.
  const series = b.series && b.series.length === b.days + 1 ? b.series : null;
  const max = Math.max(b.budget, b.projected, used, 1) * 1.15;
  const X = (d: number) => L + (d / Math.max(1, b.days)) * (w - L - R);
  const Y = (c: number) => T + (1 - c / max) * (h - T - B);
  const a = grow(t, span[0], span[1] * 0.55);
  const p = grow(t, span[0] + span[1] * 0.55, span[1] * 0.45);
  const color = TONE_STROKE[b.tone];
  const y0 = Y(0);
  const xe = X(b.elapsed);
  const ye = Y(used);
  const xEnd = X(b.days);
  const yEnd = Y(b.projected);
  const actual: [number, number][] = series ? series.slice(0, b.elapsed + 1).map((c, d) => [X(d), Y(c)]) : [[X(0), y0], [xe, ye]];
  const ahead: [number, number][] = series ? series.slice(b.elapsed).map((c, i) => [X(b.elapsed + i), Y(c)]) : [[xe, ye], [xEnd, yEnd]];
  const clip = (pts: [number, number][], f: number) => {
    // Reveal the line left to right as it animates in.
    const limit = pts[0][0] + (pts[pts.length - 1][0] - pts[0][0]) * f;
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      if (x <= limit) out.push([x, y]);
      else {
        const [px, py] = pts[i - 1];
        out.push([limit, py + ((y - py) * (limit - px)) / Math.max(1e-6, x - px)]);
        break;
      }
    }
    return out;
  };
  const path = (pts: [number, number][]) => pts.map(([x, y], i) => (i ? "L" : "M") + x + "," + y).join(" ");
  const shown = clip(actual, a);
  const text = { fontSize: 11 };
  return (
    <svg width={w} height={h} className="mt-4 overflow-visible">
      <rect x={L} y={T} width={w - L - R} height={Math.max(0, Y(b.budget) - T)} fill="#fef2f2" />
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1={L} x2={w - R} y1={Y(max * f)} y2={Y(max * f)} stroke="#f4f4f5" />
      ))}
      <line x1={L} x2={w - R} y1={y0} y2={y0} stroke="#e4e4e7" />
      <line x1={L} x2={w - R} y1={Y(b.budget)} y2={Y(b.budget)} stroke="#a1a1aa" strokeDasharray="4 4" />
      <text x={L + 4} y={Y(b.budget) - 6} className="fill-zinc-500" style={text}>
        Budget {compactMoney(b.budget)}
      </text>
      <line x1={xe} x2={xe} y1={T} y2={y0} stroke="#d4d4d8" strokeDasharray="2 3" />
      {shown.length > 1 ? (
        <>
          <path d={path(shown) + " L" + shown[shown.length - 1][0] + "," + y0 + " L" + shown[0][0] + "," + y0 + " Z"} fill={color} opacity={0.1} />
          <path d={path(shown)} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : null}
      {p > 0 ? <path d={path(clip(ahead, p))} fill="none" stroke={color} strokeWidth={2} strokeDasharray="6 5" strokeLinecap="round" strokeLinejoin="round" /> : null}
      {a >= 1 ? (
        <>
          <circle cx={xe} cy={ye} r={4.5} fill="white" stroke={color} strokeWidth={2.5} />
          <text x={xe - 8} y={ye - 10} textAnchor="end" className="fill-zinc-700" style={{ ...text, fontWeight: 600 }}>
            {compactMoney(used)} {b.used === undefined ? "posted" : "used"}
          </text>
        </>
      ) : null}
      {p >= 1 ? (
        <>
          <circle cx={xEnd} cy={yEnd} r={3.5} fill={color} />
          <text x={xEnd - 8} y={yEnd + (yEnd < Y(b.budget) || Math.abs(yEnd - Y(b.budget)) < 18 ? 18 : -10)} textAnchor="end" style={{ ...text, fontWeight: 600, fill: color }}>
            On pace for {compactMoney(b.projected)}
          </text>
        </>
      ) : null}
      <text x={L} y={h - 4} className="fill-zinc-400" style={text}>
        Day 1
      </text>
      <text x={xe} y={h - 4} textAnchor="middle" className="fill-zinc-500" style={text}>
        Today, day {b.elapsed}
      </text>
      <text x={w - R} y={h - 4} textAnchor="end" className="fill-zinc-400" style={text}>
        Day {b.days}
      </text>
    </svg>
  );
}

function ThreadView({ th, steps, messages, t, scroll }: { th: ThreadSpec; steps: number[]; messages: number[]; t: number; scroll?: boolean }) {
  return (
    <div className="mt-4">
      <ol className="flex flex-wrap items-center gap-y-1 text-[12px]">
        {th.steps.map((s, i) =>
          t >= steps[i] ? (
            <li key={i} className="animate-enter flex items-center">
              {i > 0 ? <span className={cn("mx-2 h-px w-3", s.state === "todo" ? "bg-zinc-200" : "bg-zinc-300")} /> : null}
              <span
                className={cn(
                  "flex items-center gap-1 whitespace-nowrap",
                  s.state === "done" ? (s.tone === "bad" ? "text-destructive" : "text-zinc-700") : s.state === "now" ? "font-medium text-zinc-900" : "text-zinc-400",
                )}
              >
                {s.state === "done" ? (
                  s.tone === "bad" ? <X className="size-3" strokeWidth={3} /> : <Check className="size-3 text-brand-ink" strokeWidth={3} />
                ) : null}
                {s.state === "now" ? <LoaderCircle className="size-3 animate-spin text-zinc-500" /> : null}
                {s.label}
              </span>
            </li>
          ) : null,
        )}
      </ol>
      <div className="mt-4 space-y-2.5">
        {th.messages.map((m, i) =>
          t >= messages[i] ? (
            <EmailCard key={i} m={m} reply={i > 0} scroll={scroll} />
          ) : null,
        )}
      </div>
    </div>
  );
}

/** One email, laid out like Gmail: subject, sender, recipient, body. */
function EmailCard({ m, reply, scroll }: { m: ThreadSpec["messages"][number]; reply: boolean; scroll?: boolean }) {
  return (
    <div className={cn("animate-enter overflow-hidden rounded-2xl bg-white shadow-[0_1px_2px_rgb(0_0_0/0.04)] ring-1 ring-zinc-200", reply && "ml-8")}>
      <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-2 text-[11.5px] text-zinc-500">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logos/gmail.svg" alt="" className="h-3 w-4" />
        <span className="font-medium text-zinc-600">Gmail</span>
        {reply ? <span className="text-zinc-400">· Reply</span> : null}
        {m.at ? <span className="ml-auto tnum">{m.at}</span> : null}
      </div>
      <div className="px-4 pt-3 pb-3.5">
        {m.subject ? <div className="text-[14.5px] leading-snug font-semibold text-zinc-900">{m.subject}</div> : null}
        <div className={cn("flex items-center gap-2.5", m.subject && "mt-2.5")}>
          {m.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={m.logo} alt="" className="size-8 shrink-0 rounded-full object-cover ring-1 ring-zinc-200" />
          ) : (
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-zinc-900 text-[12px] font-semibold text-white">{m.from[0]}</span>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-zinc-900">{m.from}</div>
            <div className="truncate text-[11.5px] text-zinc-500">to {m.to}</div>
          </div>
          {m.tag ? (
            <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", m.tone === "bad" ? "bg-red-50 text-destructive" : "bg-accent text-brand-ink")}>{m.tag}</span>
          ) : null}
        </div>
        <div className={cn("mt-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-600", !scroll && "line-clamp-4")}>{m.body}</div>
      </div>
    </div>
  );
}

const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

/** Which page the thumbnail shows (fractional while scrolling): down through every page, then back to the cited one. */
function scrollPage(t: number, span: [number, number] | undefined, pages: number, cited: number) {
  if (!span || t === Infinity) return cited - 1;
  const p = Math.min(1, Math.max(0, (t - span[0]) / span[1]));
  const down = 0.72;
  if (p <= down) return (pages - 1) * ease(p / down);
  return pages - 1 + (cited - pages) * ease((p - down) / (1 - down));
}

/** A compact look at the signed contract PDF. While the frame builds, the page scrolls through the PDF and lands on the cited clauses. */
function ContractCard({ c, open, t, span }: { c: ContractPreview; open?: boolean; t: number; span?: [number, number] }) {
  const page = c.page;
  const at = page ? scrollPage(t, span, page.of, page.n) : 0;
  const reading = Boolean(page && span && t !== Infinity && t < span[0] + span[1]);
  return (
    <Link
      href={contractHref(c.id, c.cited ? c.clauses[0]?.ref : null)}
      onClick={(e) => e.stopPropagation()}
      tabIndex={open ? 0 : -1}
      className={cn("animate-enter group mt-4 flex items-center gap-3.5 rounded-xl bg-[#fcfbf8] p-3 ring-1 ring-zinc-200 transition-shadow hover:ring-zinc-400", !open && "pointer-events-none")}
    >
      {page ? (
        <div className="relative aspect-[8.5/11] w-[64px] shrink-0 overflow-hidden rounded-[3px] bg-white shadow-[0_1px_2px_rgb(0_0_0/0.08),0_4px_10px_rgb(0_0_0/0.06)] ring-1 ring-zinc-200">
          <div className="absolute inset-x-0 top-0" style={{ transform: "translateY(" + (-at * 100) / page.of + "%)" }}>
            {Array.from({ length: page.of }, (_, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={contractThumb(c.id, i + 1)} alt={i + 1 === page.n ? "Page " + page.n + " of " + c.id : ""} className="aspect-[8.5/11] w-full object-cover" />
            ))}
          </div>
          <span className="absolute top-1 left-1 rounded-[2px] bg-[#c4302b] px-0.5 text-[8px] font-bold tracking-wide text-white">PDF</span>
        </div>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12px] text-zinc-500">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logos/ironclad.png" alt="" className="size-4 rounded-full object-cover" />
          <span className="truncate font-mono text-[11.5px] text-zinc-400">
            {c.id}.pdf{page ? " · p. " + (reading ? Math.round(at) + 1 : page.n) + " of " + page.of : ""}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-0.5 group-hover:text-zinc-900">
            Open <ArrowUpRight className="size-3.5" />
          </span>
        </div>
        <div className="mt-0.5 truncate text-[14px] leading-snug font-semibold text-zinc-900">{c.name}</div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {reading ? (
            <span className="text-[12px] text-zinc-400">Reading the contract...</span>
          ) : (
            c.clauses.map((cl) => (
              <span key={cl.ref} title={cl.text} className="animate-enter rounded-md bg-white px-1.5 py-0.5 text-[11.5px] text-zinc-700 ring-1 ring-zinc-200">
                <span className="font-mono text-zinc-400">§{cl.ref}</span> {cl.title}
              </span>
            ))
          )}
        </div>
      </div>
    </Link>
  );
}

/** One split of a charge as a bar, with each team's share underneath. */
function SplitRow({ parts, tag, strong }: { parts: SplitPart[]; tag: string; strong?: boolean }) {
  const total = parts.reduce((s, p) => s + p.cents, 0) || 1;
  const tones = strong ? ["bg-primary", "bg-brand-ink", "bg-primary/50"] : ["bg-zinc-300", "bg-zinc-200", "bg-zinc-100"];
  return (
    <div className="grid grid-cols-[44px_1fr] items-start gap-3">
      <span className={cn("pt-0.5 font-mono text-[12px]", strong ? "font-medium text-brand-ink" : "text-zinc-400 line-through decoration-zinc-300")}>{tag}</span>
      <div>
        <div className="flex h-3 overflow-hidden rounded-full bg-zinc-100">
          {parts.map((p, i) => (
            <div key={p.label} className={cn("h-full border-r-2 border-white last:border-r-0", tones[i % tones.length])} style={{ width: (p.cents / total) * 100 + "%" }} />
          ))}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-zinc-500">
          {parts.map((p, i) => (
            <span key={p.label} className="flex items-center gap-1">
              <span className={cn("size-1.5 rounded-full", tones[i % tones.length])} />
              {p.label}
              {p.owner ? " (owner)" : ""} <span className="font-medium text-zinc-800 tnum">{compactMoney(p.cents)}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** A rule the Controls Lead learned on this case: your words, what it changes in dollars, then the decision or where it has been used. */
function PolicyChangeView({ c, open }: { c: PolicyChange; open?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const decide = async (decision: "APPROVED" | "REJECTED") => {
    if (!c.approvalId) return;
    setBusy(decision);
    try {
      await postJson("/api/approvals/" + c.approvalId, { decision, reason: decision === "REJECTED" ? "Keep reviewing these case by case for now." : null });
      setDone(decision === "APPROVED" ? "It's the rule now." : "Kept as is.");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const live = c.state === "live";
  return (
    <div className="animate-enter flex flex-col">
      {live ? (
        <p className="mt-2 text-[14.5px] leading-snug text-zinc-600">{c.statement}</p>
      ) : c.quote ? (
        <>
          <div className="mt-4 flex justify-end">
            <div className="max-w-[82%] rounded-2xl rounded-br-md bg-zinc-100 px-3.5 py-2 text-[14.5px] leading-snug text-zinc-800">{c.quote.text}</div>
          </div>
          <div className="mt-2 flex items-center gap-2 text-[13px] text-zinc-500">
            <PixelAgent actorId="agent.policy" size={22} still />
            Becomes rule <span className="font-mono text-[12px] text-zinc-700">{c.key}</span>
            {c.replaces ? <span>, replacing &ldquo;{c.replaces}&rdquo;</span> : null}
          </div>
        </>
      ) : null}

      {live ? (
        <div className="mt-4 flex items-center gap-3 rounded-xl bg-accent/60 px-3.5 py-3 ring-1 ring-primary/30">
          <Check className="size-4 shrink-0 text-brand-ink" strokeWidth={2.5} />
          <span className="text-[13.5px] text-zinc-800">{c.liveAt ? "Rule since " + clock(c.liveAt) + ". Handed to:" : "Handed to:"}</span>
          <span className="ml-auto flex -space-x-1.5">
            {(c.handedTo ?? []).map((a) => (
              <span key={a} className="grid size-7 place-items-center rounded-full bg-white ring-2 ring-white">
                <PixelAgent actorId={a} size={22} still />
              </span>
            ))}
          </span>
        </div>
      ) : null}

      {live && c.usedBy?.length ? (
        <>
          <div className="mt-4 text-[12.5px] font-medium text-zinc-500">Used since</div>
          <div className="mt-1.5 divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200">
            {c.usedBy.map((u) => (
              <div key={u.workItemId} className="flex items-center gap-3 px-3.5 py-2 text-[13px]">
                <span className="font-mono text-[12px] text-zinc-400">{u.workItemId}</span>
                <span className="truncate text-zinc-700">{u.label}</span>
                <span className="ml-auto text-zinc-800 tnum">{compactMoney(u.amountCents)}</span>
                <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-brand-ink">without you</span>
              </div>
            ))}
          </div>
        </>
      ) : !live && !c.example && c.state === "pending" ? (
        <div className="mt-4 rounded-xl px-4 py-3 text-[13.5px] leading-snug text-zinc-500 ring-1 ring-zinc-200">
          No GPU reservation has been shared between teams this month, so nothing to re-split yet. The next shared one follows this rule.
        </div>
      ) : c.example ? (
        <div className="mt-4 rounded-xl p-4 ring-1 ring-zinc-200">
          <div className="flex items-baseline justify-between text-[12.5px]">
            <span className="font-medium text-zinc-700">{live ? "What it changes" : "On the last shared reservation"}</span>
            <span className="text-zinc-400 tnum">
              {c.example.label} · {compactMoney(c.example.totalCents)}
            </span>
          </div>
          <div className="mt-3 space-y-3">
            <SplitRow parts={c.example.before} tag="before" />
            <SplitRow parts={c.example.after} tag="after" strong />
          </div>
        </div>
      ) : null}

      <div className="mt-5 flex items-center gap-2">
        {done ? (
          <span className="text-[13px] text-zinc-600">{done}</span>
        ) : c.state === "pending" ? (
          <>
            <span className="mr-auto rounded-full bg-amber-50 px-2.5 py-1 text-[12px] font-medium text-amber-700">Waiting for you</span>
            {c.approvalId && open ? (
              <>
                <button type="button" disabled={busy !== null} onClick={(e) => (e.stopPropagation(), decide("REJECTED"))} className="rounded-lg px-3.5 py-2 text-[13.5px] text-zinc-600 ring-1 ring-zinc-200 hover:ring-zinc-400">
                  Not yet
                </button>
                <button type="button" disabled={busy !== null} onClick={(e) => (e.stopPropagation(), decide("APPROVED"))} className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 py-2 text-[13.5px] font-medium text-white hover:bg-zinc-800">
                  {busy === "APPROVED" ? <LoaderCircle className="size-3.5 animate-spin" /> : null} Make it the rule
                </button>
              </>
            ) : null}
          </>
        ) : (
          <span className="text-[12.5px] text-zinc-400">
            {c.state === "live" ? (c.quote ? "From your note on " + c.quote.who.split(", on ")[1] : c.key) + (c.replaces ? " · replaces “" + c.replaces + "”" : "") : c.state === "rejected" ? "You kept the old rule." : "Replaced by a newer version."}
          </span>
        )}
      </div>
    </div>
  );
}

/** The Controls Lead's standing frame: every rule the team follows, where it came from, and how often it has been used. */
function RulebookView({ r }: { r: NonNullable<FrameSpec["rulebook"]> }) {
  return (
    <div className="animate-enter">
      <p className="mt-1.5 text-[13.5px] text-zinc-500">{r.handled} case{r.handled === 1 ? "" : "s"} handled without you under these rules.</p>
      <div className="mt-4 space-y-2">
        {r.rules.map((x) => (
          <div key={x.key} className={cn("flex items-center gap-3 rounded-xl px-3.5 py-3 ring-1", x.isNew ? "bg-accent/50 ring-primary/40" : "ring-zinc-200")}>
            <ScrollText className={cn("size-4 shrink-0", x.isNew ? "text-brand-ink" : "text-zinc-400")} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[14px] font-medium text-zinc-900">{x.title}</span>
                {x.isNew ? <span className="rounded-full bg-primary px-1.5 py-px text-[10.5px] font-medium text-white">new</span> : null}
                {x.pending ? <span className="rounded-full bg-amber-50 px-1.5 py-px text-[10.5px] font-medium text-amber-700">waiting for you</span> : null}
              </div>
              <div className="mt-0.5 text-[12px] text-zinc-500">
                from {x.from} · <span className="font-mono text-[11px] text-zinc-400">{x.key}</span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[16px] font-semibold text-zinc-900 tnum">{x.used}</div>
              <div className="text-[11px] text-zinc-400">case{x.used === 1 ? "" : "s"}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A note that set no rule: your words, and one line back. */
function NoteOnlyView({ n }: { n: NonNullable<FrameSpec["noteOnly"]> }) {
  return (
    <div className="animate-enter">
      {n.note ? (
        <div className="mt-4 flex justify-end">
          <div className="max-w-[82%] rounded-2xl rounded-br-md bg-zinc-100 px-3.5 py-2 text-[14.5px] leading-snug text-zinc-800">{n.note}</div>
        </div>
      ) : null}
      <div className="mt-3 flex items-start gap-2.5">
        <PixelAgent actorId="agent.policy" size={28} still />
        <div className="rounded-2xl rounded-tl-md bg-white px-3.5 py-2 text-[14.5px] leading-snug text-zinc-700 ring-1 ring-zinc-200">{n.reply}</div>
      </div>
      <div className="mt-4 text-[12.5px] text-zinc-400">No rule changed.</div>
    </div>
  );
}

/** The contract PDF scrolling by while an employee reads it, with a scan line where it is reading. */
function ContractReader({ c }: { c: ContractPreview }) {
  const pages = c.page?.of ?? 1;
  const strip = useRef<HTMLDivElement>(null);
  // Scroll down through every page and back up, for as long as the employee is reading.
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const period = pages * 2400;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const travel = Math.max(0, el.offsetHeight - 300);
      const phase = ((now - start) % (2 * period)) / period;
      const p = phase <= 1 ? phase : 2 - phase;
      el.style.transform = "translateY(" + -travel * ease(p) + "px)";
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pages]);
  return (
    <div className="mt-4 flex flex-col">
      <div className="relative h-[300px] overflow-hidden rounded-xl bg-zinc-100 ring-1 ring-zinc-200">
        <div ref={strip} className="mx-auto w-[300px] space-y-3 py-4">
          {Array.from({ length: pages }, (_, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={contractThumb(c.id, i + 1)} alt={i === 0 ? c.id + " page 1" : ""} className="aspect-[8.5/11] w-full rounded-[3px] bg-white shadow-[0_1px_2px_rgb(0_0_0/0.08),0_6px_16px_rgb(0_0_0/0.08)]" />
          ))}
        </div>
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-10 -translate-y-1/2 animate-pulse border-y border-primary/50 bg-primary/10" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-8 bg-gradient-to-b from-zinc-100 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-zinc-100 to-transparent" />
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 text-[12px] text-zinc-500">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logos/ironclad.png" alt="" className="size-4 rounded-full object-cover" />
        <span className="font-mono text-[11.5px] text-zinc-400">{c.id}.pdf</span>
        <span className="truncate text-zinc-600">{c.name}</span>
        <span className="ml-auto shrink-0 text-zinc-400 tnum">{pages} pages</span>
      </div>
    </div>
  );
}

/** `fit` grows the frame to its content (the card clips it when small); otherwise it scrolls within a fixed box when `scroll` is set. */
export function FrameView({
  spec,
  play,
  delay = 0,
  scroll,
  fit,
  open,
}: {
  spec: FrameSpec;
  play: boolean;
  delay?: number;
  scroll?: boolean;
  fit?: boolean;
  /** Opened in full: long text is not clamped. */
  open?: boolean;
}) {
  const tl = timeline(spec);
  const t = useElapsed(play, delay, tl.total);
  const done = t === Infinity;
  const queryText = spec.query ? typed(spec.query.text, t, tl.query) : "";
  const queryTyping = Boolean(spec.query && tl.query && !done && t < tl.query[0] + tl.query[1]);
  const bodyText = spec.draft ? typed(spec.draft.body, t, tl.draftBody) : "";
  const bodyTyping = Boolean(spec.draft && tl.draftBody && !done && t >= tl.draftBody[0] && t < tl.draftBody[0] + tl.draftBody[1]);

  return (
    <div
      style={fit ? { width: DW, minHeight: DH } : { width: DW, height: DH }}
      className={cn("flex flex-col bg-white p-6 text-zinc-800 [&>*]:shrink-0", fit ? "" : scroll ? "overflow-y-auto overscroll-contain" : "overflow-hidden")}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 truncate font-mono text-[12px] tracking-wider text-zinc-400 uppercase">{spec.eyebrow}</div>
        {spec.source ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-zinc-50 py-0.5 pr-2.5 pl-1 text-[12px] text-zinc-500 ring-1 ring-zinc-200">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={spec.source.logo} alt="" className="size-[18px] rounded-full object-cover" />
            {spec.source.write ? "Writes to " : "From "}
            <span className="font-medium text-zinc-700">{spec.source.name}</span>
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-[21px] leading-snug font-semibold tracking-tight">{spec.title}</div>
      {spec.status ? (
        <span className={cn("mt-2 inline-flex w-fit rounded-full px-2.5 py-0.5 text-[12px] font-medium first-letter:uppercase", TONE_PILL[spec.status.tone])}>{spec.status.label}</span>
      ) : null}

      {spec.doc ? <DocView doc={spec.doc} at={tl.doc} t={t} /> : null}
      {spec.timeline ? <TimelineView spec={spec.timeline} at={tl.lanes} t={t} /> : null}
      {spec.match ? <MatchView m={spec.match} at={tl.match} result={tl.result} t={t} /> : null}
      {spec.reading ? <ContractReader c={spec.reading} /> : null}
      {spec.policyChange ? <PolicyChangeView c={spec.policyChange} open={open} /> : null}
      {spec.rulebook ? <RulebookView r={spec.rulebook} /> : null}
      {spec.noteOnly ? <NoteOnlyView n={spec.noteOnly} /> : null}
      {spec.match && spec.contract && tl.contract && t >= tl.contract[0] ? <ContractCard c={spec.contract} open={open} t={t} span={tl.contract} /> : null}
      {spec.stack ? <StackView s={spec.stack} at={tl.stack} legend={tl.legend} t={t} /> : null}
      {spec.burn ? <BurnView b={spec.burn} span={tl.burn} t={t} /> : null}
      {spec.thread ? <ThreadView th={spec.thread} steps={tl.steps} messages={tl.messages} t={t} scroll={scroll || open} /> : null}

      {spec.query ? (
        <pre className="mt-4 rounded-xl bg-zinc-950 p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-100">
          <Highlight text={queryText} lang={spec.query.lang} />
          <Caret on={queryTyping} />
        </pre>
      ) : null}

      {spec.table && (done || t >= (tl.rows[0] ?? 0)) ? (
        <div className="mt-4 overflow-hidden rounded-xl ring-1 ring-zinc-200">
          <div className="flex gap-3 border-b bg-zinc-50 px-3 py-1.5 font-mono text-[11px] tracking-wider text-zinc-400 uppercase">
            {spec.table.cols.map((c, i) => (
              <span key={c} className={i === 0 ? "w-[34%] shrink-0" : "min-w-0 flex-1"}>
                {c}
              </span>
            ))}
          </div>
          {spec.table.rows.map((r, i) =>
            t >= tl.rows[i] ? (
              <div key={i} className="animate-enter flex gap-3 border-b px-3 py-1.5 text-[13px] last:border-b-0">
                {r.map((cell, j) => (
                  <span key={j} className={j === 0 ? "w-[34%] shrink-0 truncate text-zinc-500" : "min-w-0 flex-1 truncate text-zinc-800 tnum"}>
                    {cell}
                  </span>
                ))}
              </div>
            ) : null,
          )}
        </div>
      ) : null}

      {spec.bars?.length ? (
        <div className="mt-4 space-y-2.5">
          {spec.bars.map((b, i) => (
            <div key={i}>
              <div className="flex justify-between text-[13px]">
                <span className="text-zinc-600">{b.label}</span>
                <span className="text-zinc-800 tnum">{t >= tl.bars[i] ? b.display : ""}</span>
              </div>
              <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-zinc-100">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
                  style={{ width: (t >= tl.bars[i] ? Math.min(1, Math.max(0.02, b.share)) * 100 : 0) + "%" }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {spec.ledger ? (
        <div className="mt-4 overflow-hidden rounded-xl ring-1 ring-zinc-200">
          <div className="grid grid-cols-[64px_1fr_96px_96px] gap-2 border-b bg-zinc-50 px-3 py-1.5 font-mono text-[11px] tracking-wider text-zinc-400 uppercase">
            <span>Acct</span>
            <span>Memo</span>
            <span className="text-right">Debit</span>
            <span className="text-right">Credit</span>
          </div>
          {spec.ledger.lines.map((l, i) =>
            t >= tl.ledger[i] ? (
              <div key={i} className="animate-enter grid grid-cols-[64px_1fr_96px_96px] gap-2 border-b px-3 py-1.5 text-[13px] last:border-b-0">
                <span className="font-mono text-zinc-500">{l.account}</span>
                <span className="truncate">{l.memo}</span>
                <span className="text-right tnum">{l.dr}</span>
                <span className="text-right tnum">{l.cr}</span>
              </div>
            ) : null,
          )}
          {t >= tl.balance ? (
            <div className={cn("animate-enter px-3 py-1.5 text-[12.5px] font-medium", spec.ledger.balanced ? "bg-accent text-brand-ink" : "bg-red-50 text-destructive")}>
              {spec.ledger.balanced ? "Balanced" : "Out of balance"}
            </div>
          ) : null}
        </div>
      ) : null}

      {spec.draft && t >= tl.draftHead ? (
        <div className="animate-enter mt-4 rounded-xl ring-1 ring-zinc-200">
          <div className="space-y-0.5 border-b px-4 py-2.5 text-[13px]">
            <div>
              <span className="text-zinc-400">To </span>
              {spec.draft.to}
            </div>
            <div>
              <span className="text-zinc-400">Subject </span>
              <span className="font-medium">{spec.draft.subject}</span>
            </div>
          </div>
          <div className="min-h-[96px] px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap text-zinc-700">
            {bodyText}
            <Caret on={bodyTyping} />
          </div>
        </div>
      ) : null}

      {spec.checks?.length ? <CheckList checks={spec.checks} at={tl.checks} t={t} /> : null}

      {spec.summary && t >= tl.summary ? (
        <p title={spec.summary} className={cn("animate-enter mt-3 line-clamp-2 text-[13.5px] leading-relaxed text-zinc-600", !open && "[&_a]:pointer-events-none")}>
          <ContractLinked text={spec.summary} contractId={spec.contract?.id} />
        </p>
      ) : null}

      {spec.contract && !spec.match && t >= (tl.contract?.[0] ?? tl.summary) ? <ContractCard c={spec.contract} open={open} t={t} span={tl.contract} /> : null}

      {spec.evidence?.length && t >= tl.summary ? (
        <div className="animate-enter mt-2.5 flex h-[22px] flex-wrap gap-1.5 overflow-hidden">
          {spec.evidence.map((e) => {
            const id = e.match(CONTRACT_ID)?.[0];
            if (id && spec.contract) return null;
            return id ? (
              <Link
                key={e}
                href={contractHref(id)}
                onClick={(ev) => ev.stopPropagation()}
                tabIndex={open ? 0 : -1}
                className={cn("rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-[11px] text-zinc-600 underline decoration-zinc-300 underline-offset-2 hover:bg-zinc-200/70 hover:text-zinc-900", !open && "pointer-events-none")}
              >
                {e}
              </Link>
            ) : (
              <span key={e} className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-[11px] text-zinc-500">
                {e}
              </span>
            );
          })}
        </div>
      ) : null}

      {spec.sources?.length && !spec.contract && t >= tl.summary ? (
        <div className="animate-enter mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] text-zinc-400">Read</span>
          {spec.sources.map((s) =>
            s === "Contract" && spec.contract ? (
              <Link
                key={s}
                href={contractHref(spec.contract.id)}
                onClick={(e) => e.stopPropagation()}
                tabIndex={open ? 0 : -1}
                className={cn("flex items-center gap-0.5 rounded-full bg-white px-2 py-0.5 text-[11.5px] text-zinc-700 ring-1 ring-zinc-300 hover:ring-zinc-500", !open && "pointer-events-none")}
              >
                {s} <ArrowUpRight className="size-3" />
              </Link>
            ) : (
              <span key={s} className="rounded-full bg-white px-2 py-0.5 text-[11.5px] text-zinc-600 ring-1 ring-zinc-200">
                {s}
              </span>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

