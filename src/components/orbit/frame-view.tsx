"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, LoaderCircle, Minus, X } from "lucide-react";
import type { BurnSpec, Check as CheckRow, DocSpec, FrameSpec, MatchSpec, StackSpec, ThreadSpec, TimelineSpec, Tone } from "@/lib/frames";
import { compactMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

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
    each(spec.match.rows.length + 1, 300, tl.match);
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
  tl.total = t + 500;
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
            <span key={i} className="text-[#e2ee8f]">
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
      <span key={m.index} className={m[2] ? "text-[#e2ee8f]" : "text-[#c6d600]"}>
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
        {spec.lanes.map((l, i) =>
          t >= at[i] ? (
            <div key={l.key} className="animate-enter flex items-center gap-3 py-1.5">
              <div style={{ width: LANE_LABEL }} className="shrink-0">
                <div className="text-[13px] font-medium text-zinc-700">{l.label}</div>
                <div className={cn("text-[12px] tnum", l.tone === "bad" ? "text-destructive" : "text-zinc-500")}>{l.value}</div>
              </div>
              <div className="relative h-6 flex-1 rounded-md bg-zinc-50 ring-1 ring-zinc-100">
                {l.spans.map((s, j) => (
                  <div
                    key={j}
                    className={cn("absolute inset-y-1 rounded-sm", TONE_BG[s.tone ?? l.tone])}
                    style={{ left: s.from * 100 + "%", width: Math.max(0.5, (s.to - s.from) * 100) * grow(t, at[i] + 100, 600) + "%" }}
                  />
                ))}
              </div>
            </div>
          ) : null,
        )}
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
        <div className="animate-enter flex items-center gap-3 bg-zinc-50 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">{m.head.label}</div>
            <div className="truncate text-[12px] text-zinc-500">{m.head.detail}</div>
          </div>
          <div className="text-[16px] font-semibold tnum">{m.head.value}</div>
        </div>
      ) : null}
      {m.rows.map((r, i) =>
        t >= at[i + 1] ? (
          <div key={i} className="animate-enter flex items-center gap-3 border-t px-4 py-2">
            <span className={cn("size-2 shrink-0 rounded-full", TONE_BG[r.tone])} />
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] text-zinc-800">{r.label}</div>
              {r.detail ? <div className="truncate text-[12px] text-zinc-500">{r.detail}</div> : null}
            </div>
            {r.delta ? <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] whitespace-nowrap tnum", TONE_PILL[deltaTone(r)])}>{r.delta}</span> : null}
            <span className="w-[88px] shrink-0 text-right text-[14px] tnum">{r.value}</span>
          </div>
        ) : null,
      )}
      {t >= result ? (
        <div className={cn("animate-enter flex items-center justify-between gap-3 px-4 py-2.5 text-[14px] font-semibold", TONE_PILL[m.result.tone])}>
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
  const max = Math.max(b.budget, b.projected, b.posted, 1) * 1.15;
  const X = (d: number) => L + (d / Math.max(1, b.days)) * (w - L - R);
  const Y = (c: number) => T + (1 - c / max) * (h - T - B);
  const a = grow(t, span[0], span[1] * 0.55);
  const p = grow(t, span[0] + span[1] * 0.55, span[1] * 0.45);
  const color = TONE_STROKE[b.tone];
  const x0 = X(0);
  const y0 = Y(0);
  const xe = X(b.elapsed);
  const ye = Y(b.posted);
  const xEnd = X(b.days);
  const yEnd = Y(b.projected);
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
      <path d={"M" + x0 + "," + y0 + " L" + xe + "," + ye + " L" + xe + "," + y0 + " Z"} fill={color} opacity={0.1 * a} />
      <line x1={x0} y1={y0} x2={x0 + (xe - x0) * a} y2={y0 + (ye - y0) * a} stroke={color} strokeWidth={2.5} strokeLinecap="round" />
      {p > 0 ? (
        <line x1={xe} y1={ye} x2={xe + (xEnd - xe) * p} y2={ye + (yEnd - ye) * p} stroke={color} strokeWidth={2} strokeDasharray="6 5" strokeLinecap="round" />
      ) : null}
      {a >= 1 ? (
        <>
          <circle cx={xe} cy={ye} r={4.5} fill="white" stroke={color} strokeWidth={2.5} />
          <text x={xe - 8} y={ye - 10} textAnchor="end" className="fill-zinc-700" style={{ ...text, fontWeight: 600 }}>
            {compactMoney(b.posted)} posted
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
      <ol className="flex flex-wrap items-center gap-y-1">
        {th.steps.map((s, i) =>
          t >= steps[i] ? (
            <li key={i} className="animate-enter flex items-center">
              {i > 0 ? <span className={cn("mx-1 h-px w-4", s.state === "todo" ? "bg-zinc-200" : "bg-zinc-400")} /> : null}
              <span
                className={cn(
                  "flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] whitespace-nowrap",
                  s.state === "done" ? TONE_PILL[s.tone ?? "ok"] : s.state === "now" ? "bg-white text-zinc-700 ring-1 ring-zinc-300" : "bg-zinc-50 text-zinc-400",
                )}
              >
                {s.state === "done" ? s.tone === "bad" ? <X className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} /> : null}
                {s.state === "now" ? <LoaderCircle className="size-3 animate-spin" /> : null}
                {s.label}
              </span>
            </li>
          ) : null,
        )}
      </ol>
      <div className="mt-3 space-y-2">
        {th.messages.map((m, i) =>
          t >= messages[i] ? (
            <div
              key={i}
              className={cn(
                "animate-enter rounded-xl px-4 py-2.5 ring-1",
                m.tone === "bad" ? "bg-red-50/60 ring-red-100" : m.tone === "ok" ? "bg-accent/60 ring-accent" : "bg-white ring-zinc-200",
                i > 0 && "ml-10",
              )}
            >
              <div className="flex gap-1.5 text-[12px] text-zinc-500">
                <span className="font-medium text-zinc-700">{m.from}</span>
                <span>to {m.to}</span>
              </div>
              {m.subject ? <div className="mt-0.5 text-[13.5px] font-medium">{m.subject}</div> : null}
              <div className={cn("mt-1 text-[13px] leading-relaxed whitespace-pre-wrap text-zinc-600", !scroll && "line-clamp-4")}>{m.body}</div>
            </div>
          ) : null,
        )}
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
      className={cn("flex flex-col bg-white p-7 text-zinc-800 [&>*]:shrink-0", fit ? "" : scroll ? "overflow-y-auto overscroll-contain" : "overflow-hidden")}
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

      {spec.summary && t >= tl.summary ? <p className="animate-enter mt-4 text-[14px] leading-relaxed text-zinc-600">{spec.summary}</p> : null}

      {spec.evidence?.length && t >= tl.summary ? (
        <div className="animate-enter mt-3 flex flex-wrap gap-1.5">
          {spec.evidence.map((e) => (
            <span key={e} className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-[11px] text-zinc-500">
              {e}
            </span>
          ))}
        </div>
      ) : null}

      {spec.sources?.length && t >= tl.summary ? (
        <div className="animate-enter mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] text-zinc-400">Read</span>
          {spec.sources.map((s) => (
            <span key={s} className="rounded-full bg-white px-2 py-0.5 text-[11.5px] text-zinc-600 ring-1 ring-zinc-200">
              {s}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

