"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, LoaderCircle, Minus, X } from "lucide-react";
import type { Check as CheckRow, FrameSpec } from "@/lib/frames";
import { cn } from "@/lib/utils";

/** Frames are laid out at this size, then scaled into the small card on the canvas. */
export const DW = 640;
export const DH = 480;

type Timeline = {
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

function timeline(spec: FrameSpec): Timeline {
  let t = 200;
  const tl: Timeline = { rows: [], bars: [], ledger: [], balance: 0, draftHead: 0, checks: [], summary: 0, total: 0 };
  if (spec.query) {
    const d = Math.min(1500, spec.query.text.length * 14);
    tl.query = [t, d];
    t += d + 220;
  }
  const each = (count: number, gap: number, into: number[]) => {
    for (let i = 0; i < count; i++) {
      into.push(t);
      t += gap;
    }
  };
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

export function FrameView({ spec, play, delay = 0, scroll }: { spec: FrameSpec; play: boolean; delay?: number; scroll?: boolean }) {
  const tl = timeline(spec);
  const t = useElapsed(play, delay, tl.total);
  const done = t === Infinity;
  const queryText = spec.query ? typed(spec.query.text, t, tl.query) : "";
  const queryTyping = Boolean(spec.query && tl.query && !done && t < tl.query[0] + tl.query[1]);
  const bodyText = spec.draft ? typed(spec.draft.body, t, tl.draftBody) : "";
  const bodyTyping = Boolean(spec.draft && tl.draftBody && !done && t >= tl.draftBody[0] && t < tl.draftBody[0] + tl.draftBody[1]);

  return (
    <div
      style={{ width: DW, height: DH }}
      className={cn("flex flex-col bg-white p-7 text-zinc-800", scroll ? "overflow-y-auto overscroll-contain" : "overflow-hidden")}
    >
      <div className="font-mono text-[12px] tracking-wider text-zinc-400 uppercase">{spec.eyebrow}</div>
      <div className="mt-1 text-[21px] leading-snug font-semibold tracking-tight">{spec.title}</div>

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
    </div>
  );
}

