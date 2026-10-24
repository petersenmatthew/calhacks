"use client";

import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { outcomeOf } from "@/lib/decision";
import { taskSummary } from "@/lib/summary";
import { cn } from "@/lib/utils";
import type { WorkspaceData } from "@/server/queries";
import { AgentAvatar } from "../status";

/** A check that pops in; with `burst`, a ring and sparks fly out of it (the moment a task closes). */
export function DoneMark({ burst = false, size = 36 }: { burst?: boolean; size?: number }) {
  const sparks = burst ? Array.from({ length: 12 }, (_, i) => (i / 12) * Math.PI * 2) : [];
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      {burst ? <span className="done-ring absolute inset-0 rounded-full bg-primary/50" /> : null}
      {sparks.map((a, i) => (
        <span
          key={i}
          className={cn("done-spark absolute size-1.5 rounded-full", i % 2 ? "bg-primary" : "bg-brand-ink")}
          style={{ ["--dx" as string]: Math.cos(a) * size * 1.1 + "px", ["--dy" as string]: Math.sin(a) * size * 1.1 + "px", animationDelay: "120ms" }}
        />
      ))}
      <span className={cn("grid size-full place-items-center rounded-full bg-primary text-primary-foreground shadow-sm", burst && "done-pop")}>
        <Check style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={3} />
      </span>
    </span>
  );
}

/**
 * The wrap-up for a finished task: the outcome, the money, and who did what.
 * `justFinished` plays the arrival once, when the task closes while you watch.
 */
export function DoneCard({ w, justFinished }: { w: WorkspaceData; justFinished: boolean }) {
  const card = useRef<HTMLDivElement>(null);
  // Bring the wrap-up into view when the task closes, wherever the panel was scrolled.
  useEffect(() => {
    if (justFinished) card.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [justFinished]);
  const o = outcomeOf(w);
  const s = taskSummary(w);
  const meta = [
    s.took ? "Closed in " + s.took : "Closed",
    s.agents ? s.agents + (s.agents === 1 ? " agent" : " agents") : null,
    s.you ? s.you + (s.you === 1 ? " decision" : " decisions") + " from you" : "no decisions needed from you",
  ].filter(Boolean);
  const rise = (i: number) => (justFinished ? { className: "done-rise", style: { animationDelay: 250 + i * 90 + "ms" } } : { className: "", style: undefined });
  return (
    <div ref={card} className={cn("scroll-mt-5 rounded-2xl bg-accent/40 p-4 ring-1 ring-primary/40", justFinished && "animate-flash")}>
      <div className="flex items-start gap-3">
        <DoneMark burst={justFinished} />
        <div className="min-w-0">
          <div className="text-[11.5px] font-semibold tracking-wide text-brand-ink uppercase">Done</div>
          <h2 className="mt-0.5 text-[17px] leading-snug font-semibold tracking-[-0.01em] text-balance text-zinc-950">{o.title}</h2>
          <p className="mt-0.5 text-[12.5px] text-zinc-500">{meta.join(" · ")}</p>
        </div>
      </div>

      <dl className={cn("mt-4 grid gap-2", s.figures.length >= 3 ? "grid-cols-3" : "grid-cols-2")}>
        {s.figures.map((f, i) => {
          const r = rise(i);
          return (
            <div key={f.label} className={cn("rounded-xl bg-white/80 px-3 py-2 ring-1 ring-zinc-200/70", r.className)} style={r.style}>
              <dt className="text-[11px] leading-tight text-zinc-500">{f.label}</dt>
              <dd className={cn("text-[15px] font-semibold tnum", f.tone === "good" ? "text-brand-ink" : f.tone === "muted" ? "text-zinc-400" : "text-zinc-900")}>{f.value}</dd>
            </div>
          );
        })}
      </dl>

      {s.steps.length ? (
        <ol className="mt-4 space-y-2.5">
          {s.steps.map((step, i) => {
            const r = rise(s.figures.length + i);
            const name = w.actors[step.actorId]?.name ?? (step.actorId === "system.ledger_gateway" ? "Ledger gateway" : step.actorId);
            return (
              <li key={i} className={cn("flex gap-2", r.className)} style={r.style}>
                <AgentAvatar actorId={step.actorId} size="sm" className="mt-px" />
                <div className="min-w-0 text-[12.5px] leading-snug">
                  <span className="font-medium text-zinc-800">{step.actorId.startsWith("human.") ? "You" : name}</span>
                  <span className="text-zinc-600"> {step.text}</span>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
