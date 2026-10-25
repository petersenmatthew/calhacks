"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronUp, LoaderCircle, Plus } from "lucide-react";
import { agentSteps, boardStage } from "@/lib/agent-steps";
import { postJson } from "@/lib/api";
import { askVerb, buildDecision, outcomeOf, shortTitle } from "@/lib/decision";
import { clockTime, compactMoney, money } from "@/lib/format";
import { buildFeed } from "@/lib/narration";
import { isDone } from "@/lib/summary";
import { cn } from "@/lib/utils";
import type { DashboardData, WorkspaceData } from "@/server/queries";
import { DecisionThread, type TalkTurn } from "../review/decision-thread";
import type { DecisionTurn } from "@/server/assistant";
import { DisputeLetter } from "../comms/dispute-letter";
import { DoneFinale } from "./done-card";
import { VendorThread } from "../comms/vendor-thread";
import { ContractLinked } from "../contract/contract-link";
import { FLOWER_COLORS, Flower, MeadowStrip, UI_FLOWERS } from "../landing/meadow";
import { AgentAvatar } from "../status";
import { LearnedPolicyRow, pendingLearnedPolicy, RunningOnItsOwn, useAutonomy } from "../autonomy/sidebar-parts";

type Item = DashboardData["workItems"][number];
export type ChatMessage = { role: "user" | "assistant"; content: string };

/**
 * Keeps a scrolling chat pinned to its newest line as content arrives (new
 * messages, typed-out text, typing dots). Scrolling up to read unpins it;
 * scrolling back to the bottom pins it again. Jumps to the bottom whenever key changes.
 */
function useStickToBottom(ref: React.RefObject<HTMLElement | null>, key: string | null) {
  useEffect(() => {
    const el = ref.current;
    if (!el || key === null) return;
    let pinned = true;
    const follow = () => {
      if (pinned) el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => {
      pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    follow();
    const resize = new ResizeObserver(follow);
    const watch = () => {
      resize.disconnect();
      for (const c of Array.from(el.children)) resize.observe(c);
    };
    watch();
    const mutate = new MutationObserver(() => {
      watch();
      follow();
    });
    mutate.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      resize.disconnect();
      mutate.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [ref, key]);
}

export type Group = "needs" | "moving" | "done";

export function groupOf(i: Item): Group {
  const s = boardStage(i);
  return s === "needs_you" ? "needs" : s === "done" ? "done" : "moving";
}

/** The money at stake on a row: the overbilled part for disputes, else the charge. */
function stake(i: Item) {
  return i.discrepancyCents > 0 && i.type !== "SHARED_ALLOCATION" ? i.discrepancyCents : i.amountCents;
}

function greeting(now: Date) {
  const h = now.getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/* ------------------------------------------------------------------ rows */

function TaskRow({ item, data, onOpen, active, dup }: { item: Item; data: DashboardData; onOpen: () => void; active?: boolean; dup?: boolean }) {
  const g = groupOf(item);
  const working = data.agents.some((a) => a.currentWorkItemId === item.id && a.status === "working");
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex h-10 w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors hover:bg-zinc-100/80",
        active && "bg-zinc-100",
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center">
        {working ? (
          <LoaderCircle className="size-3.5 animate-spin text-brand-ink" />
        ) : g === "needs" ? (
          <Flower petal={FLOWER_COLORS[2].petal} eye={FLOWER_COLORS[2].eye} size={10} />
        ) : g === "done" ? (
          <Check className="size-3 text-brand-ink" strokeWidth={2.5} />
        ) : item.state === "DISPUTED" ? (
          <span className="size-[7px] rounded-full border-[1.5px] border-zinc-400" />
        ) : (
          <span className="size-[7px] rounded-full bg-zinc-300" />
        )}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-[14px]", g === "done" ? "text-zinc-500" : "text-zinc-900")}>
        {shortTitle(item, data.providers)}
        {dup && item.resource ? <span className="ml-1.5 font-mono text-[11px] text-zinc-400">{item.resource}</span> : null}
      </span>
      {g === "needs" ? (
        <span className="hidden text-[11.5px] text-zinc-400 group-hover:inline">{askVerb(item)}</span>
      ) : null}
      <span className={cn("text-[12px] tnum", g === "needs" ? "text-zinc-600 group-hover:hidden" : "text-zinc-400")}>{money(stake(item), { cents: false })}</span>
    </button>
  );
}

function Section({ title, count, children, collapsible, flower }: { title: string; count: number; children: ReactNode; collapsible?: boolean; flower?: (typeof FLOWER_COLORS)[number] }) {
  const [open, setOpen] = useState(!collapsible);
  if (!count) return null;
  return (
    <section className="mt-5 first:mt-0">
      <button
        type="button"
        disabled={!collapsible}
        onClick={() => setOpen(!open)}
        className="mb-1 flex w-full items-center gap-2 px-2.5 text-[13px] font-medium text-zinc-500 enabled:hover:text-zinc-800"
      >
        {flower ? <Flower petal={flower.petal} eye={flower.eye} size={11} className="-mt-0.5" /> : null}
        {title}
        <span className="text-zinc-400 tnum">{count}</span>
        {collapsible ? <ChevronDown className={cn("ml-auto size-3.5 transition-transform", !open && "-rotate-90")} /> : null}
      </button>
      {open ? <div>{children}</div> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ home */

/** Where each project's compute spend is heading this month. */
function Books({ data }: { data: DashboardData }) {
  const b = data.budgets;
  return (
    <div className="mt-5 space-y-2 px-2.5">
      {b.projects.length ? (
        <div className="rounded-2xl bg-white p-3.5 ring-1 ring-zinc-200">
          <div className="flex items-baseline justify-between">
            <span className="text-[14px] font-medium text-zinc-900">Compute budgets</span>
            <span className="text-[11.5px] text-zinc-400 tnum">
              Day {b.elapsed} of {b.daysInMonth}
            </span>
          </div>
          <ul className="mt-2 space-y-2">
            {b.projects.map((p) => {
              const max = Math.max(p.budget, p.projected, 1);
              const tone = p.projected > p.budget ? "bad" : p.projected > p.budget * 0.9 ? "warn" : "ok";
              return (
                <li key={p.id} title={compactMoney(p.posted) + " posted, on pace for " + compactMoney(p.projected) + " of " + compactMoney(p.budget)}>
                  <div className="flex justify-between gap-2 text-[12px]">
                    <span className="truncate text-zinc-700">{p.name}</span>
                    <span className={cn("shrink-0 tnum", tone === "bad" ? "text-destructive" : tone === "warn" ? "text-amber-700" : "text-zinc-600")}>
                      {compactMoney(p.projected)}
                      <span className="text-zinc-400"> / {compactMoney(p.budget)}</span>
                    </span>
                  </div>
                  <div className="relative mt-1 h-1.5 rounded-full bg-zinc-100">
                    <div className="absolute inset-y-0 left-0 rounded-full bg-zinc-200" style={{ width: (p.projected / max) * 100 + "%" }} />
                    <div
                      className={cn("absolute inset-y-0 left-0 rounded-full", tone === "bad" ? "bg-red-500" : tone === "warn" ? "bg-amber-400" : "bg-primary")}
                      style={{ width: (p.posted / max) * 100 + "%" }}
                    />
                    <div className="absolute -inset-y-0.5 w-px bg-zinc-500" style={{ left: (p.budget / max) * 100 + "%" }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Home({ data, items, onOpen }: { data: DashboardData; items: Item[]; onOpen: (id: string) => void }) {
  const autonomy = useAutonomy();
  const learned = pendingLearnedPolicy(autonomy.data) ? 1 : 0;
  const needs = items.filter((i) => groupOf(i) === "needs");
  const moving = items.filter((i) => groupOf(i) === "moving");
  const done = items.filter((i) => groupOf(i) === "done");
  // A public demo calls the controller "You": greet without a name then.
  const full = data.actors["human.controller"]?.name ?? "";
  const name = full === "You" ? "" : full.split(" ")[0];
  const [now] = useState(() => new Date());
  const decisions = needs.length + learned;
  const minutes = Math.max(1, Math.ceil((decisions * 12) / 60));
  const titles = items.map((i) => shortTitle(i, data.providers));
  const dup = (i: Item) => titles.filter((t) => t === shortTitle(i, data.providers)).length > 1;
  return (
    <div className="pb-4">
      <MeadowStrip seed={5} className="block h-14 w-full" />
      <div className="px-3 pt-5">
      <div className="px-2.5">
        <h2 className="text-[24px] leading-[1.15] font-semibold tracking-[-0.02em] text-zinc-950">
          {greeting(now)}
          {name ? ", " + name : ""}
        </h2>
        <p className="mt-1.5 text-[14px] text-zinc-600">
          {decisions
            ? decisions + (decisions === 1 ? " decision" : " decisions") + ", about " + minutes + " min"
            : moving.length
              ? "Nothing needs you. Agents are on " + moving.length + "."
              : "All clear for " + data.period + "."}
        </p>
      </div>
      <Books data={data} />
      <div className="mt-6">
        <Section title="Needs you" count={decisions} flower={FLOWER_COLORS[2]}>
          {autonomy.data ? <LearnedPolicyRow data={autonomy.data} refresh={() => autonomy.mutate()} /> : null}
          {needs.map((i) => (
            <TaskRow key={i.id} item={i} data={data} dup={dup(i)} onOpen={() => onOpen(i.id)} />
          ))}
        </Section>
        <Section title="In progress" count={moving.length} flower={FLOWER_COLORS[1]}>
          {moving.map((i) => (
            <TaskRow key={i.id} item={i} data={data} dup={dup(i)} onOpen={() => onOpen(i.id)} />
          ))}
        </Section>
        {autonomy.data ? <RunningOnItsOwn data={autonomy.data} /> : null}
        <Section title="Done" count={done.length} collapsible flower={UI_FLOWERS.green}>
          {done.map((i) => (
            <TaskRow key={i.id} item={i} data={data} dup={dup(i)} onOpen={() => onOpen(i.id)} />
          ))}
        </Section>
      </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ task */

/** Types a line out once, when it first arrives while the page is open. */
function Typed({ text, on, contractId }: { text: string; on: boolean; contractId?: string | null }) {
  const [shown, setShown] = useState(on ? 0 : text.length);
  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const next = Math.min(text.length, Math.floor(((now - start) / 1000) * 90));
      setShown(next);
      if (next < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on, text]);
  return (
    <>
      {shown >= text.length ? <ContractLinked text={text} contractId={contractId} /> : text.slice(0, shown)}
      {shown < text.length ? <span className="ml-0.5 inline-block h-[1em] w-[0.45em] translate-y-[0.15em] animate-pulse bg-zinc-400" /> : null}
    </>
  );
}

/** Whether the feed shows the dispute email inline, right after the Vendor Liaison sends it. */
function letterInFeed(w: WorkspaceData) {
  return Boolean(w.dispute?.letterBody) && buildFeed(w).some((l) => l.kind === "agent" && l.tool === "send_vendor_dispute");
}

/** The employees explaining their work to you as they go, plus your own decisions. */
function Feed({ w, letter = true }: { w: WorkspaceData; letter?: boolean }) {
  const lines = buildFeed(w);
  const here = w.agents.filter((a) => a.currentWorkItemId === w.item.id && a.status !== "idle");
  const [openedAt] = useState(() => Date.now());
  return (
    <div className="space-y-3">
      {lines.map((l, i) => {
        if (l.kind === "event") {
          return (
            <div key={l.id} className="animate-enter flex items-start gap-2 text-[12px] leading-snug text-zinc-400">
              <span className="mt-[5px] size-1 shrink-0 rounded-full bg-zinc-300" />
              {l.text}
            </div>
          );
        }
        if (l.kind === "you") {
          return (
            <div key={l.id} className="animate-enter flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-zinc-100 px-3.5 py-2 text-[13px] leading-snug text-zinc-900">{l.text}</div>
            </div>
          );
        }
        const prev = lines[i - 1];
        const grouped = prev?.kind === "agent" && prev.actorId === l.actorId;
        return (
          <div key={l.id} className={cn("animate-enter", grouped && "-mt-1.5")}>
            {!grouped ? (
              <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-zinc-600">
                <AgentAvatar actorId={l.actorId} size="sm" />
                {w.actors[l.actorId]?.name ?? l.actorId}
                <span className="font-normal text-zinc-400 tnum">{clockTime(l.at).slice(0, 5)}</span>
              </div>
            ) : null}
            <div className={cn("pl-[26px] text-[13.5px] leading-relaxed", l.tone === "bad" ? "text-destructive" : "text-zinc-800")}>
              <Typed text={l.text} on={Date.parse(l.at) > openedAt - 3000} contractId={w.contract.id} />
            </div>
            {letter && l.tool === "send_vendor_dispute" && w.dispute?.letterBody ? (
              <div className="mt-2.5 pl-[26px]">
                <DisputeLetter dispute={w.dispute} />
              </div>
            ) : null}
          </div>
        );
      })}
      {here.map((a) => {
        const step = a.status === "working" ? agentSteps(a.agentId, a.runTools, "running").current : null;
        return (
          <div key={"now-" + a.agentId} className="flex items-center gap-1.5 text-[12.5px] text-zinc-500">
            <AgentAvatar actorId={a.agentId} size="sm" />
            <span className="font-medium text-zinc-600">{w.actors[a.agentId]?.name}</span>
            <span>{a.status === "working" ? (step?.verb ?? "Working").toLowerCase() : "is up next"}</span>
            {a.status === "working" ? (
              <span className="ml-0.5 flex gap-0.5">
                {[0, 150, 300].map((d) => (
                  <span key={d} className="size-1 animate-pulse rounded-full bg-zinc-400" style={{ animationDelay: d + "ms" }} />
                ))}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** One quiet footer row: the story so far on the left, the full record on the right. */
function HowWeGotHere({ w, extra, letter }: { w: WorkspaceData; extra?: ReactNode; letter?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between text-[12.5px] text-zinc-500">
        <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 hover:text-zinc-900">
          <ChevronDown className={cn("size-3.5 transition-transform", !open && "-rotate-90")} />
          How we got here
        </button>
        {extra}
      </div>
      {open ? (
        <div className="mt-4">
          <Feed w={w} letter={letter} />
        </div>
      ) : null}
    </div>
  );
}

/** True once, for the render after this task moved to done while it was on screen. */
function useJustFinished(w: WorkspaceData) {
  const seen = useRef<{ id: string; state: string } | null>(null);
  const [finishedId, setFinishedId] = useState<string | null>(null);
  useEffect(() => {
    const prev = seen.current;
    seen.current = { id: w.item.id, state: w.item.state };
    if (prev && prev.id === w.item.id && !isDone(prev.state) && isDone(w.item.state)) setFinishedId(w.item.id);
  }, [w.item.id, w.item.state]);
  return finishedId === w.item.id;
}

function TaskView({
  w,
  onDecided,
  turns,
  pending,
  chat,
  chatPending,
  onTask,
}: {
  w: WorkspaceData;
  onDecided: () => void;
  turns: TalkTurn[];
  pending: boolean;
  /** Questions asked about this task, answered in place. */
  chat: ChatMessage[];
  chatPending: boolean;
  onTask: (id: string) => void;
}) {
  const decision = buildDecision(w);
  const justFinished = useJustFinished(w);
  const record = (
    <Link href={"/investigations/" + w.item.id + "/record"} className="inline-flex items-center gap-0.5 hover:text-zinc-900">
      Full record <ArrowUpRight className="size-3" />
    </Link>
  );
  if (decision) {
    return (
      <div className="px-5 pt-5 pb-6">
        <DecisionThread
          key={w.item.id + (decision.approvalId ?? "q")}
          w={w}
          decision={decision}
          turns={turns}
          pending={pending}
          onDone={onDecided}
        />
        <HowWeGotHere w={w} extra={record} />
      </div>
    );
  }
  const o = outcomeOf(w);
  const busy = w.agents.some((a) => a.currentWorkItemId === w.item.id && a.status !== "idle");
  if (isDone(w.item.state) && !busy) {
    return (
      <div className="animate-enter space-y-5 px-5 pt-5 pb-6">
        <div>
          <div className="text-[12px] text-zinc-500">
            {(w.providers[w.item.providerId]?.shortName ?? "") + " · " + (w.item.instanceId ?? w.item.reservationId ?? w.item.id)}
          </div>
          <h2 className="mt-1.5 text-[17px] leading-snug font-semibold tracking-[-0.01em] text-balance text-zinc-950">
            {shortTitle({ ...w.item, resource: w.item.instanceId ?? w.item.reservationId }, w.providers)}
          </h2>
        </div>
        {/* The whole conversation stays: the work, the email where it was sent, the replies, then how it ended. */}
        <Feed w={w} />
        {w.dispute?.letterBody && !letterInFeed(w) ? <DisputeLetter dispute={w.dispute} /> : null}
        <VendorThread w={w} />
        <DoneFinale w={w} justFinished={justFinished} />
        <div className="text-[12.5px] text-zinc-500">{record}</div>
        {chat.length || chatPending ? <Thread messages={chat} pending={chatPending} onTask={onTask} inset contractId={w.contract.id} /> : null}
      </div>
    );
  }
  return (
    <div className="animate-enter space-y-5 px-5 pt-5 pb-6">
      <div>
        <div className="text-[12px] text-zinc-500">
          {(w.providers[w.item.providerId]?.shortName ?? "") + " · " + (w.item.instanceId ?? w.item.reservationId ?? w.item.id)}
        </div>
        <h2 className="mt-3 text-[19px] leading-[1.25] font-semibold tracking-[-0.015em] text-balance text-zinc-950">
          {busy ? shortTitle({ ...w.item, resource: w.item.instanceId ?? w.item.reservationId }, w.providers) : o.title}
        </h2>
        <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-zinc-500">
          {o.tone === "done" && !busy ? <Check className="size-3.5 text-brand-ink" strokeWidth={2.5} /> : null}
          {busy ? "Nothing needed from you yet" : (o.detail ?? "Nothing needed from you")}
        </p>
      </div>
      <Feed w={w} />
      {w.dispute?.letterBody && !letterInFeed(w) ? <DisputeLetter dispute={w.dispute} /> : null}
      <VendorThread w={w} />
      <div className="text-[12.5px] text-zinc-500">{record}</div>
      {chat.length || chatPending ? <Thread messages={chat} pending={chatPending} onTask={onTask} inset contractId={w.contract.id} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ chat */

function Linked({ text, onTask, contractId }: { text: string; onTask: (id: string) => void; contractId?: string | null }) {
  const parts = text.split(/(WI-\d{4})/g);
  return (
    <>
      {parts.map((p, i) =>
        /^WI-\d{4}$/.test(p) ? (
          <button key={i} type="button" onClick={() => onTask(p)} className="rounded bg-zinc-100 px-1 font-mono text-[12px] text-zinc-700 hover:bg-accent hover:text-brand-ink">
            {p}
          </button>
        ) : (
          <span key={i}>
            <ContractLinked text={p} contractId={contractId} />
          </span>
        ),
      )}
    </>
  );
}

function Thread({
  messages,
  pending,
  onTask,
  speaker,
  inset,
  contractId,
}: {
  messages: ChatMessage[];
  pending: boolean;
  onTask: (id: string) => void;
  /** Who answers, when it is one employee rather than the assistant. */
  speaker?: { actorId: string; name: string };
  /** Inside a padded view: no padding of its own. */
  inset?: boolean;
  /** The contract this conversation is about, so "contract" and clause numbers link to it. */
  contractId?: string | null;
}) {
  return (
    <div className={cn("space-y-4", inset ? "border-t border-zinc-100 pt-5" : "px-5 pt-5 pb-4")}>
      {messages.map((m, i) =>
        m.role === "user" ? (
          <div key={i} className="animate-enter flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-zinc-100 px-3.5 py-2 text-[13.5px] leading-snug whitespace-pre-wrap text-zinc-900">{m.content}</div>
          </div>
        ) : (
          <div key={i} className="animate-enter text-[13.5px] leading-relaxed whitespace-pre-wrap text-zinc-800">
            {speaker ? (
              <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-zinc-500">
                <AgentAvatar actorId={speaker.actorId} size="sm" />
                {speaker.name}
              </div>
            ) : null}
            <Linked text={m.content} onTask={onTask} contractId={contractId} />
          </div>
        ),
      )}
      {pending ? (
        <div className="flex gap-1 py-1">
          {[0, 150, 300].map((d) => (
            <span key={d} className="size-1.5 animate-pulse rounded-full bg-zinc-300" style={{ animationDelay: d + "ms" }} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Composer({ placeholder, onSend, disabled, focusKey = 0 }: { placeholder: string; onSend: (text: string) => void; disabled: boolean; focusKey?: number }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusKey) ref.current?.focus();
  }, [focusKey]);
  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [text]);
  return (
    <div className="flex items-end gap-2 rounded-2xl bg-white p-1.5 pl-3.5 shadow-[0_1px_2px_rgb(0_0_0/0.04)] ring-1 ring-zinc-200 transition-shadow focus-within:ring-zinc-400">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        className="min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-snug outline-none placeholder:text-zinc-400"
      />
      <button
        type="button"
        onClick={submit}
        disabled={!text.trim() || disabled}
        aria-label="Send"
        className="grid size-8 shrink-0 place-items-center rounded-xl bg-zinc-900 text-white transition-colors hover:bg-zinc-800 disabled:bg-zinc-100 disabled:text-zinc-400"
      >
        <ArrowUp className="size-4" />
      </button>
    </div>
  );
}

const SUGGESTIONS = ["What is blocking close?", "Where are we overbilled most?"];

/** Suggested questions above the composer, one per row. */
function Suggestions({ items, onPick }: { items: string[]; onPick: (s: string) => void }) {
  return (
    <div className="mb-2 px-0.5">
      {items.map((s) => (
        <button key={s} type="button" onClick={() => onPick(s)} className="group flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-zinc-600 hover:bg-zinc-100/80 hover:text-zinc-950">
          <span className="min-w-0 flex-1 truncate">{s}</span>
          <ArrowUpRight className="size-3.5 text-zinc-300 group-hover:text-zinc-600" />
        </button>
      ))}
    </div>
  );
}


/** The frame the controller opened, and the employee who made it. */
export type FrameChatTarget = {
  /** Tagged frame id, unique across tasks; chats are kept per frame. */
  key: string;
  taskId: string;
  /** Untagged frame id as the server builds it. */
  frameId: string;
  actorId: string;
  agentName: string;
  job: string;
  label: string;
  title: string;
  tone: "ok" | "warn" | "denied" | "live";
};

const FRAME_TONE_DOT: Record<FrameChatTarget["tone"], string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-400",
  denied: "bg-red-500",
  live: "bg-primary animate-pulse",
};

function frameSuggestions(f: FrameChatTarget) {
  if (f.tone === "denied") return ["Why was this blocked?", "What happens next?"];
  if (f.tone === "live") return ["What are you doing right now?", "What have you found so far?"];
  return ["Walk me through this", "Where do these numbers come from?", "What would change your call?"];
}

/** Talk to the employee who made the open frame, about that frame. */
function FrameChat({
  f,
  messages,
  pending,
  onAsk,
  onClose,
  onTask,
  contractId,
}: {
  f: FrameChatTarget;
  messages: ChatMessage[];
  pending: boolean;
  onAsk: (text: string) => void;
  onClose: () => void;
  onTask: (id: string) => void;
  contractId?: string | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  useStickToBottom(scroller, f.key);
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-zinc-100 px-3">
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
        >
          <ArrowLeft className="size-3.5" />
          Back to task
        </button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-5 pt-5">
          <div className="flex items-center gap-3">
            <AgentAvatar actorId={f.actorId} size="lg" />
            <div className="min-w-0">
              <div className="text-[15px] font-semibold text-zinc-900">{f.agentName}</div>
              <div className="text-[12.5px] text-zinc-500">{f.job}</div>
            </div>
          </div>
          <div className="mt-4 rounded-xl bg-zinc-50 px-3.5 py-3 ring-1 ring-zinc-100">
            <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-500">
              <span className={cn("size-1.5 rounded-full", FRAME_TONE_DOT[f.tone])} />
              {f.label}
            </div>
            <div className="mt-1 text-[13.5px] leading-snug font-medium text-zinc-800">{f.title}</div>
          </div>
        </div>
        {messages.length ? (
          <Thread messages={messages} pending={pending} onTask={onTask} speaker={{ actorId: f.actorId, name: f.agentName }} contractId={contractId} />
        ) : (
          <p className="px-5 pt-5 text-[13px] leading-relaxed text-zinc-500">Ask about this frame. {f.agentName.split(" ")[0]} answers from the records behind it.</p>
        )}
      </div>
      <div className="shrink-0 px-3 pt-2 pb-3">
        {!messages.length ? (
          <Suggestions items={frameSuggestions(f)} onPick={onAsk} />
        ) : null}
        <Composer placeholder={"Ask " + f.agentName + " about this"} onSend={onAsk} disabled={pending} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ sidebar */

/**
 * The canvas sidebar: your tasks, the decision for the focused task, and an
 * assistant that answers questions about the books.
 */
export function Sidebar({
  data,
  items,
  task,
  w,
  onTask,
  onDecided,
  agentPanel,
  frameChat,
  onCloseFrame,
}: {
  data: DashboardData;
  items: Item[];
  task: string | null;
  /** The focused task's data, once loaded. */
  w?: WorkspaceData;
  onTask: (id: string | null) => void;
  onDecided: () => void;
  /** Rendered instead of everything else when a seat on the ring is focused. */
  agentPanel?: ReactNode;
  /** The open frame: the sidebar becomes a chat with the employee who made it. */
  frameChat?: FrameChatTarget;
  onCloseFrame?: () => void;
}) {
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [frameChats, setFrameChats] = useState<Record<string, ChatMessage[]>>({});
  const [framePending, setFramePending] = useState<string | null>(null);
  // Conversations about pending decisions, one per decision.
  const [talks, setTalks] = useState<Record<string, TalkTurn[]>>({});
  const [talkPending, setTalkPending] = useState<string | null>(null);
  // Questions about a task without a pending decision stay in that task's view.
  const [taskChats, setTaskChats] = useState<Record<string, ChatMessage[]>>({});
  const [taskPending, setTaskPending] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const needs = items.filter((i) => groupOf(i) === "needs");
  const ring = task && needs.some((i) => i.id === task) ? needs : items;
  const index = task ? ring.findIndex((i) => i.id === task) : -1;
  const step = (dir: 1 | -1) => {
    if (index < 0 || ring.length < 2) return;
    onTask(ring[(index + dir + ring.length) % ring.length].id);
  };

  const latest = useRef({ step, needs, task, chatOpen, onTask });
  useEffect(() => {
    latest.current = { step, needs, task, chatOpen, onTask };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      const l = latest.current;
      if (e.key === "j" || e.key === "J") l.step(1);
      else if (e.key === "k" || e.key === "K") l.step(-1);
      else if (e.key === "Enter" && !l.task && !l.chatOpen && l.needs[0]) l.onTask(l.needs[0].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ask = async (text: string) => {
    const next = [...chat, { role: "user" as const, content: text }];
    setChat(next);
    setChatOpen(true);
    setPending(true);
    try {
      const res = await postJson<{ reply: string }>("/api/assistant", { messages: next, taskId: task });
      setChat((c) => [...c, { role: "assistant", content: res.reply }]);
    } catch (e) {
      setChat((c) => [...c, { role: "assistant", content: "Something went wrong: " + (e as Error).message }]);
    } finally {
      setPending(false);
    }
  };

  const ready = w && w.item.id === task ? w : undefined;
  const mode = frameChat ? "frame" : agentPanel ? "agent" : chatOpen ? "chat" : task ? "task" : "home";
  // Chats stay pinned to the newest message; the home list starts at the top.
  useStickToBottom(scroller, mode === "task" || mode === "chat" ? mode + ":" + (task ?? "") : null);
  useEffect(() => {
    if (mode === "home") scroller.current?.scrollTo({ top: 0 });
  }, [mode]);
  const pendingDecision = ready ? buildDecision(ready) : null;
  const talkKey = ready && pendingDecision ? ready.item.id + ":" + (pendingDecision.approvalId ?? "q") : null;
  const talkTo = pendingDecision ? (ready?.actors[pendingDecision.askedBy]?.name ?? "the agent") : null;

  /** In a decision, the chat box talks to the employee who asked. */
  const reply = async (text: string) => {
    if (!talkKey || !ready) return;
    const k = talkKey;
    const next = [...(talks[k] ?? []), { role: "user" as const, content: text }];
    setTalks((m) => ({ ...m, [k]: next }));
    setTalkPending(k);
    let turn: TalkTurn;
    try {
      const r = await postJson<DecisionTurn>("/api/work-items/" + ready.item.id + "/discuss", { messages: next.map(({ role, content }) => ({ role, content })) });
      turn = { role: "assistant", content: r.reply, choiceId: r.choiceId, note: r.note, budget: r.budget };
    } catch (e) {
      turn = { role: "assistant", content: "Something went wrong: " + (e as Error).message };
    }
    setTalks((m) => ({ ...m, [k]: [...(m[k] ?? []), turn] }));
    setTalkPending((p) => (p === k ? null : p));
  };
  const talking = mode === "task" && talkKey !== null;

  const askTask = async (text: string) => {
    if (!task) return;
    const k = task;
    const next = [...(taskChats[k] ?? []), { role: "user" as const, content: text }];
    setTaskChats((m) => ({ ...m, [k]: next }));
    setTaskPending(k);
    let content: string;
    try {
      content = (await postJson<{ reply: string }>("/api/assistant", { messages: next, taskId: k })).reply;
    } catch (e) {
      content = "Something went wrong: " + (e as Error).message;
    }
    setTaskChats((m) => ({ ...m, [k]: [...(m[k] ?? []), { role: "assistant", content }] }));
    setTaskPending((p) => (p === k ? null : p));
  };

  const askFrame = async (f: FrameChatTarget, text: string) => {
    const next = [...(frameChats[f.key] ?? []), { role: "user" as const, content: text }];
    setFrameChats((m) => ({ ...m, [f.key]: next }));
    setFramePending(f.key);
    let reply: string;
    try {
      reply = (await postJson<{ reply: string }>("/api/assistant", { messages: next, taskId: f.taskId, frameId: f.frameId })).reply;
    } catch (e) {
      reply = "Something went wrong: " + (e as Error).message;
    }
    setFrameChats((m) => ({ ...m, [f.key]: [...(m[f.key] ?? []), { role: "assistant", content: reply }] }));
    setFramePending((k) => (k === f.key ? null : k));
  };

  const btn = "grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:pointer-events-none disabled:opacity-30";

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col border-l border-zinc-200/80 bg-white" onClick={(e) => e.stopPropagation()}>
      {mode === "frame" && frameChat ? (
        <FrameChat
          f={frameChat}
          contractId={w && w.item.id === frameChat.taskId ? w.contract.id : null}
          messages={frameChats[frameChat.key] ?? []}
          pending={framePending === frameChat.key}
          onAsk={(t) => askFrame(frameChat, t)}
          onClose={() => onCloseFrame?.()}
          onTask={(id) => {
            onCloseFrame?.();
            onTask(id);
          }}
        />
      ) : mode === "agent" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">{agentPanel}</div>
      ) : (
        <>
          {mode !== "home" ? (
            <div className="flex h-12 shrink-0 items-center gap-1 border-b border-zinc-100 px-3">
              <button
                type="button"
                onClick={() => (mode === "chat" ? setChatOpen(false) : onTask(null))}
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
              >
                <ArrowLeft className="size-3.5" />
                {mode === "chat" ? (task ? "Back to task" : "Tasks") : "All tasks"}
              </button>
              {mode === "task" && index >= 0 ? (
                <div className="ml-auto flex items-center gap-0.5">
                  <span className="mr-1 text-[11.5px] text-zinc-400 tnum">
                    {index + 1} of {ring.length}
                  </span>
                  <button type="button" className={btn} disabled={ring.length < 2} onClick={() => step(-1)} title="Previous (K)" aria-label="Previous task">
                    <ChevronUp className="size-4" />
                  </button>
                  <button type="button" className={btn} disabled={ring.length < 2} onClick={() => step(1)} title="Next (J)" aria-label="Next task">
                    <ChevronDown className="size-4" />
                  </button>
                </div>
              ) : null}
              {mode === "chat" ? (
                <button
                  type="button"
                  onClick={() => {
                    setChat([]);
                    setChatOpen(false);
                  }}
                  className="ml-auto flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                >
                  <Plus className="size-3.5" /> New chat
                </button>
              ) : null}
            </div>
          ) : null}

          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
            {mode === "home" ? (
              <Home data={data} items={items} onOpen={onTask} />
            ) : mode === "chat" ? (
              <Thread messages={chat} pending={pending} onTask={(id) => { setChatOpen(false); onTask(id); }} contractId={ready?.contract.id} />
            ) : ready ? (
              <TaskView
                w={ready}
                onDecided={onDecided}
                turns={talkKey ? (talks[talkKey] ?? []) : []}
                pending={talkPending !== null && talkPending === talkKey}
                chat={taskChats[ready.item.id] ?? []}
                chatPending={taskPending === ready.item.id}
                onTask={onTask}
              />
            ) : (
              <div className="space-y-3 px-5 pt-6">
                <div className="h-3 w-32 animate-pulse rounded bg-zinc-100" />
                <div className="h-6 w-64 animate-pulse rounded bg-zinc-100" />
                <div className="h-24 animate-pulse rounded-xl bg-zinc-50" />
              </div>
            )}
          </div>

          <div className="shrink-0 px-3 pt-2 pb-3">
            {mode === "home" && !chat.length ? (
              <Suggestions items={SUGGESTIONS} onPick={ask} />
            ) : null}
            {mode === "home" && chat.length ? (
              <button type="button" onClick={() => setChatOpen(true)} className="mb-2 px-1 text-[12px] text-zinc-500 hover:text-zinc-900">
                Continue chat ({chat.length})
              </button>
            ) : null}
            <Composer
              placeholder={talking ? "Ask " + talkTo + ", or tell them what to do" : task ? "Ask about this task" : "Ask about your books"}
              onSend={talking ? reply : mode === "task" ? askTask : ask}
              disabled={talking ? talkPending === talkKey : mode === "task" ? taskPending === task : pending}
            />
          </div>
        </>
      )}
    </aside>
  );
}

