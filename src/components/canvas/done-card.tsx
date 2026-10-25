"use client";

import { Check } from "lucide-react";
import { outcomeOf } from "@/lib/decision";
import { money } from "@/lib/format";
import { taskSummary } from "@/lib/summary";
import { cn } from "@/lib/utils";
import type { WorkspaceData } from "@/server/queries";
import { AgentAvatar } from "../status";

const whole = (c: number) => money(c, { cents: c % 100 !== 0 });

/** A check that pops in; with burst, a ring and sparks fly out of it (the moment a task closes). */
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

/** Who did what, oldest first, as a quiet vertical timeline. */
function Story({ w, rise }: { w: WorkspaceData; rise: (i: number) => { className: string; style?: React.CSSProperties } }) {
  const s = taskSummary(w);
  if (!s.steps.length) return null;
  return (
    <ol className="relative space-y-3 before:absolute before:top-2.5 before:bottom-2.5 before:left-[9px] before:w-px before:bg-zinc-200">
      {s.steps.map((step, i) => {
        const you = step.actorId.startsWith("human.");
        const name = you ? "You" : (w.actors[step.actorId]?.name ?? (step.actorId === "system.ledger_gateway" ? "Ledger gateway" : step.actorId));
        const r = rise(2 + i);
        return (
          <li key={i} className={cn("relative flex gap-2.5", r.className)} style={r.style}>
            <span className="relative z-10 h-fit rounded-full bg-white ring-[3px] ring-white">
              <AgentAvatar actorId={step.actorId} size="sm" />
            </span>
            <div className="min-w-0 text-[12.5px] leading-snug">
              <span className="font-medium text-zinc-800">{name}</span> <span className="text-zinc-500">{step.text}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The end of a finished task, at the bottom where new things arrive: the outcome,
 * where the money went, and who did what. justFinished plays the arrival once.
 */
export function DoneFinale({ w, justFinished }: { w: WorkspaceData; justFinished: boolean }) {
  const o = outcomeOf(w);
  const s = taskSummary(w);
  const f = s.flow;
  const figures = [
    { key: "billed", cents: f.billed, label: "Billed", tone: "text-zinc-900" },
    { key: "charged", cents: f.charged, label: "To team", tone: "text-zinc-900" },
    { key: "recovered", cents: f.recovered, label: "Recovered", tone: "text-brand-ink" },
    { key: "lost", cents: f.lost, label: "Not recovered", tone: "text-destructive" },
  ].filter((x) => x.key === "billed" || x.cents > 0);
  // The team that worked it, in the order they joined.
  const crew = [...new Set(w.activity.map((a) => a.actorId).filter((id) => id.startsWith("agent.")))];
  const team = [
    crew.length ? crew.length + (crew.length === 1 ? " agent" : " agents") : null,
    s.you ? s.you + (s.you === 1 ? " call" : " calls") + " from you" : "no input from you",
  ]
    .filter(Boolean)
    .join(" and ");
  const rise = (i: number) => (justFinished ? { className: "done-rise", style: { animationDelay: 300 + i * 90 + "ms" } } : { className: "", style: undefined });
  return (
    <div className={cn("overflow-hidden rounded-2xl bg-white ring-1 ring-zinc-200", justFinished ? "done-rise" : "animate-enter")}>
      <div className="px-4 pt-4">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-brand-ink">
          <DoneMark burst={justFinished} size={16} />
          {s.took ? "Done in " + s.took : "Done"}
        </div>
        <div className="mt-1.5 text-[17px] leading-snug font-semibold tracking-[-0.015em] text-balance text-zinc-950">{o.title}</div>
        {crew.length ? (
          <div className="mt-3 flex items-center gap-2 text-[12px] text-zinc-500">
            <span className="flex -space-x-1.5">
              {crew.map((a) => (
                <AgentAvatar key={a} actorId={a} size="md" className="ring-2 ring-white" />
              ))}
            </span>
            <span>{team}</span>
          </div>
        ) : null}
      </div>
      {f.billed ? (
        <div className={cn("px-4 pt-4", rise(0).className)} style={rise(0).style}>
          <dl className="flex divide-x divide-zinc-200 rounded-xl bg-zinc-50 py-2.5 ring-1 ring-zinc-100">
            {figures.map((x) => (
              <div key={x.key} className={cn("min-w-0 flex-1 px-3", x.key === "recovered" && "relative")}>
                <dt className="text-[11px] text-zinc-500">{x.label}</dt>
                <dd className={cn("mt-0.5 text-[15px] leading-tight font-semibold tracking-[-0.01em] tnum", x.tone)}>
                  {x.key === "recovered" ? "+" : ""}
                  {whole(x.cents)}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      <div className="px-4 pt-4 pb-4">
        <Story w={w} rise={rise} />
      </div>
    </div>
  );
}
