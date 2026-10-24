"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronUp } from "lucide-react";
import { agentSteps, AGENT_SHORT } from "@/lib/agent-steps";
import { fetcher } from "@/lib/api";
import { buildDecision, outcomeOf, shortTitle } from "@/lib/decision";
import { cn } from "@/lib/utils";
import type { DashboardData, WorkspaceData } from "@/server/queries";
import { useShell, viewHref } from "../app-shell";
import { groupOf } from "../canvas/sidebar";
import { dashboardKey } from "../dashboard/dashboard";
import { useLiveRefresh } from "../live-events";
import { AgentAvatar } from "../status";
import { ReservationUsage } from "../workspace/reservation-usage";
import { UsageTimeline } from "../workspace/usage-timeline";
import { DecisionCard } from "./decision-card";
import { ProofView } from "./proof";
import { ReviewSwitcher } from "./switcher";

type Variant = "focus" | "proof";

function typing(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

/** Waiting tasks in order, and where this one sits among them. */
function useQueue(id: string) {
  const { period } = useShell();
  const { data, mutate } = useSWR<DashboardData>(dashboardKey(period), fetcher, { keepPreviousData: true });
  const items = (data?.workItems ?? []).filter((i) => i.period === data?.period);
  const needs = items.filter((i) => groupOf(i) === "needs");
  const ring = needs.some((i) => i.id === id) ? needs : items;
  return { data, mutate, needs, ring, index: ring.findIndex((i) => i.id === id) };
}

function Progress({ index, total }: { index: number; total: number }) {
  if (index < 0 || !total) return null;
  const dots = Math.min(total, 24);
  const at = Math.round((index / Math.max(total - 1, 1)) * (dots - 1));
  return (
    <div className="flex items-center gap-3">
      <div className="flex gap-[3px]">
        {Array.from({ length: dots }).map((_, i) => (
          <span key={i} className={cn("h-1 w-2.5 rounded-full transition-colors", i < at ? "bg-zinc-400" : i === at ? "bg-zinc-900" : "bg-zinc-200")} />
        ))}
      </div>
      <span className="text-[12px] text-zinc-500 tnum">
        {index + 1} of {total}
      </span>
    </div>
  );
}

/** The agents that worked the task, in order, ending with you. */
function Chain({ w, waiting }: { w: WorkspaceData; waiting: boolean }) {
  const order = w.runs.map((r) => r.agentId).filter((a, i, all) => all.indexOf(a) === i);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {order.map((a) => {
        const runs = w.runs.filter((r) => r.agentId === a);
        const last = runs.at(-1);
        const tools = last ? w.activity.filter((e) => e.runId === last.id && e.toolName).map((e) => e.toolName!) : [];
        const status = last?.status === "running" || last?.status === "completed" || last?.status === "failed" ? last.status : "none";
        const steps = agentSteps(a, tools, status).steps;
        return (
          <div key={a} className="contents">
            <div className="flex items-center gap-2 rounded-full bg-white py-1 pr-3 pl-1 ring-1 ring-zinc-200">
              <AgentAvatar actorId={a} size="sm" />
              <span className="text-[12.5px] text-zinc-700">{AGENT_SHORT[a] ?? a}</span>
              <span className="flex gap-0.5">
                {steps.map((s) => (
                  <span key={s.label} title={s.label} className={cn("size-1.5 rounded-full", s.state === "done" ? "bg-brand-ink/70" : s.state === "active" ? "animate-pulse bg-primary" : "bg-zinc-200")} />
                ))}
              </span>
            </div>
            <ArrowRight className="size-3.5 text-zinc-300" />
          </div>
        );
      })}
      <div className={cn("flex h-[30px] items-center rounded-full px-3 text-[12.5px] font-medium ring-1", waiting ? "bg-accent text-brand-ink ring-primary/50" : "bg-white text-zinc-500 ring-zinc-200")}>
        You
      </div>
    </div>
  );
}

function OutcomeBlock({ w, size }: { w: WorkspaceData; size: "sm" | "lg" }) {
  const o = outcomeOf(w);
  const busy = w.agents.some((a) => a.currentWorkItemId === w.item.id && a.status !== "idle");
  return (
    <div className="animate-enter">
      <div className="text-[12px] text-zinc-500">{(w.providers[w.item.providerId]?.shortName ?? "") + " · " + (w.item.instanceId ?? w.item.reservationId ?? w.item.id)}</div>
      <h2 className={cn("mt-3 font-semibold tracking-[-0.015em] text-balance text-zinc-950", size === "lg" ? "text-[26px] leading-[1.15]" : "text-[19px]")}>
        {busy ? shortTitle({ ...w.item, resource: w.item.instanceId ?? w.item.reservationId }, w.providers) : o.title}
      </h2>
      <p className="mt-1.5 flex items-center gap-1.5 text-[15px] text-zinc-500">
        {!busy && o.tone === "done" ? <Check className="size-4 text-brand-ink" strokeWidth={2.5} /> : null}
        {busy ? "Agents are working on it. Nothing needed from you yet." : (o.detail ?? "Nothing needed from you")}
      </p>
    </div>
  );
}

export function ReviewPage({ id, variant }: { id: string; variant: Variant }) {
  const router = useRouter();
  const { lastView } = useShell();
  const { data: w, mutate } = useSWR<WorkspaceData>("/api/work-items/" + id, fetcher);
  useLiveRefresh(() => mutate(), (e) => e.workItemId === id || e.workItemId === null, 150);
  const q = useQueue(id);
  const [cleared, setCleared] = useState(false);
  const suffix = variant === "proof" ? "?v=proof" : "";
  const go = (to: string) => router.push("/investigations/" + to + suffix);
  const back = lastView === "canvas" ? "/canvas?task=" + id : viewHref(lastView);

  const keys = useRef({ q, go, back });
  useEffect(() => {
    keys.current = { q, go, back };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const { q, go, back } = keys.current;
      if (e.key === "Escape") router.push(back);
      if ((e.key === "j" || e.key === "J") && q.index >= 0 && q.ring.length > 1) go(q.ring[(q.index + 1) % q.ring.length].id);
      if ((e.key === "k" || e.key === "K") && q.index >= 0 && q.ring.length > 1) go(q.ring[(q.index - 1 + q.ring.length) % q.ring.length].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const decision = w ? buildDecision(w) : null;
  const onDone = async () => {
    void q.mutate();
    await new Promise((r) => window.setTimeout(r, 900));
    const fresh = await mutate();
    if (fresh && buildDecision(fresh)) return;
    const at = q.needs.findIndex((i) => i.id === id);
    const rest = [...q.needs.slice(at + 1), ...q.needs.slice(0, Math.max(at, 0))].filter((i) => i.id !== id);
    if (rest[0]) go(rest[0].id);
    else setCleared(true);
  };
  const nextWaiting = q.needs.find((i) => i.id !== id);

  const record = (
    <Link href={"/investigations/" + id + "/record"} className="inline-flex items-center gap-0.5 hover:text-zinc-900">
      Full record <ArrowUpRight className="size-3" />
    </Link>
  );
  const nav = (
    <div className="flex items-center gap-0.5">
      <button type="button" disabled={q.ring.length < 2} onClick={() => go(q.ring[(q.index - 1 + q.ring.length) % q.ring.length].id)} title="Previous (K)" aria-label="Previous" className="grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-30">
        <ChevronUp className="size-4" />
      </button>
      <button type="button" disabled={q.ring.length < 2} onClick={() => go(q.ring[(q.index + 1) % q.ring.length].id)} title="Next (J)" aria-label="Next" className="grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-30">
        <ChevronDown className="size-4" />
      </button>
    </div>
  );
  const backLink = (
    <Link href={back} title="Back (Esc)" className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">
      <ArrowLeft className="size-3.5" />
      {lastView === "canvas" ? "Canvas" : "Board"}
    </Link>
  );

  const body = !w ? (
    <div className="space-y-3">
      <div className="h-3 w-40 animate-pulse rounded bg-zinc-100" />
      <div className="h-8 w-80 animate-pulse rounded bg-zinc-100" />
      <div className="h-32 animate-pulse rounded-xl bg-zinc-50" />
    </div>
  ) : cleared ? (
    <div className="animate-enter text-center">
      <span className="mx-auto grid size-10 place-items-center rounded-full bg-primary text-primary-foreground">
        <Check className="size-5" strokeWidth={2.5} />
      </span>
      <h2 className="mt-4 text-[22px] font-semibold tracking-tight text-zinc-950">All clear</h2>
      <p className="mt-1 text-[14px] text-zinc-500">Nothing else needs you. The agents take it from here.</p>
      <Link href={back} className="mt-6 inline-flex h-10 items-center rounded-xl bg-zinc-900 px-4 text-[13.5px] font-medium text-white hover:bg-zinc-800">
        Back to {lastView === "canvas" ? "canvas" : "board"}
      </Link>
    </div>
  ) : decision ? (
    <DecisionCard key={id + (decision.approvalId ?? "q")} w={w} decision={decision} size="lg" proof={variant === "focus"} keys onDone={onDone} footer={variant === "focus" ? undefined : record} />
  ) : (
    <div className="space-y-6">
      <OutcomeBlock w={w} size="lg" />
      {nextWaiting ? (
        <button type="button" onClick={() => go(nextWaiting.id)} className="flex h-12 w-full items-center justify-between rounded-xl bg-zinc-900 px-4 text-[14px] font-medium text-white hover:bg-zinc-800">
          Next decision <ArrowRight className="size-4" />
        </button>
      ) : null}
    </div>
  );

  if (variant === "focus") {
    return (
      <div className="relative h-full overflow-y-auto bg-[#fafaf9]">
        <div className="sticky top-0 z-10 grid h-14 grid-cols-[1fr_auto_1fr] items-center bg-[#fafaf9]/90 px-4 backdrop-blur">
          <div>{backLink}</div>
          <Progress index={q.index} total={q.ring.length} />
          <div className="flex items-center justify-end gap-3 text-[12.5px] text-zinc-500">
            {record}
            {nav}
          </div>
        </div>
        <main className="mx-auto max-w-[480px] px-4 pt-[9vh] pb-28">
          <div className="rounded-[22px] bg-white p-7 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-8px_rgb(0_0_0/0.08)] ring-1 ring-zinc-200/70">{body}</div>
          {decision && !cleared ? (
            <p className="mt-5 text-center text-[11.5px] text-zinc-400">
              Press a number to choose · J and K to skip · Esc to leave
            </p>
          ) : null}
        </main>
        <ReviewSwitcher taskId={id} current="focus" className="fixed right-5 bottom-5 z-40" />
      </div>
    );
  }

  const isInstance = w?.item.checks && (w.item.checks as { kind: string }).kind === "instance";
  return (
    <div className="relative grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_440px]">
      <section className="min-h-0 overflow-y-auto bg-[#fafaf9]">
        <div className="flex h-12 items-center px-4">{backLink}</div>
        {w ? (
          <div className="mx-auto max-w-[720px] space-y-6 px-8 pt-[4vh] pb-24">
            <div className="text-[12px] font-medium text-zinc-500">What the agents found</div>
            {decision?.proof?.kind === "compare" && decision.proof.unit !== "h" ? (
              <div className="rounded-2xl bg-white p-7 ring-1 ring-zinc-200/70">
                <ProofView proof={decision.proof} size="lg" />
              </div>
            ) : null}
            <div className="rounded-2xl bg-white p-6 ring-1 ring-zinc-200/70">
              {isInstance ? <UsageTimeline data={w} /> : <ReservationUsage data={w} />}
            </div>
            <div>
              <div className="mb-2.5 text-[12px] font-medium text-zinc-500">Who worked on it</div>
              <Chain w={w} waiting={Boolean(decision)} />
            </div>
          </div>
        ) : null}
      </section>
      <aside className="min-h-0 overflow-y-auto border-l border-zinc-200/80 bg-white">
        <div className="flex h-12 items-center justify-between border-b border-zinc-100 px-4">
          <Progress index={q.index} total={q.ring.length} />
          {nav}
        </div>
        <div className="px-7 pt-8 pb-24">{body}</div>
      </aside>
      <ReviewSwitcher taskId={id} current="proof" className="fixed bottom-5 left-1/2 z-40 -translate-x-1/2 lg:left-[calc((100%-440px)/2)]" />
    </div>
  );
}

