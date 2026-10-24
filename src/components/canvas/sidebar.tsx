"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronUp, LoaderCircle, Plus } from "lucide-react";
import { agentSteps, boardStage } from "@/lib/agent-steps";
import { postJson } from "@/lib/api";
import { askVerb, buildDecision, outcomeOf, shortTitle } from "@/lib/decision";
import { compactMoney, dateOnly, money, periodLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardData, WorkspaceData } from "@/server/queries";
import { DecisionCard } from "../review/decision-card";
import { AgentAvatar } from "../status";

type Item = DashboardData["workItems"][number];
export type ChatMessage = { role: "user" | "assistant"; content: string };

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
        "group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors hover:bg-zinc-100/80",
        active && "bg-zinc-100",
      )}
    >
      <span className="grid size-3.5 shrink-0 place-items-center">
        {working ? (
          <LoaderCircle className="size-3.5 animate-spin text-brand-ink" />
        ) : g === "needs" ? (
          <span className="size-[7px] rounded-full bg-primary ring-[3px] ring-primary/25" />
        ) : g === "done" ? (
          <Check className="size-3 text-zinc-400" strokeWidth={2.5} />
        ) : item.state === "DISPUTED" ? (
          <span className="size-[7px] rounded-full border-[1.5px] border-zinc-400" />
        ) : (
          <span className="size-[7px] rounded-full bg-zinc-300" />
        )}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-[13px]", g === "done" ? "text-zinc-500" : "text-zinc-800")}>
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

function Section({ title, count, children, collapsible }: { title: string; count: number; children: ReactNode; collapsible?: boolean }) {
  const [open, setOpen] = useState(!collapsible);
  if (!count) return null;
  return (
    <section className="mt-5 first:mt-0">
      <button
        type="button"
        disabled={!collapsible}
        onClick={() => setOpen(!open)}
        className="mb-1 flex w-full items-center gap-1.5 px-2.5 text-[12px] font-medium text-zinc-500 enabled:hover:text-zinc-800"
      >
        {title}
        <span className="text-zinc-400 tnum">{count}</span>
        {collapsible ? <ChevronDown className={cn("ml-auto size-3.5 transition-transform", !open && "-rotate-90")} /> : null}
      </button>
      {open ? <div>{children}</div> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ home */

function Donut({ pct }: { pct: number }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  return (
    <svg width={44} height={44} viewBox="0 0 44 44" className="shrink-0 -rotate-90">
      <circle cx={22} cy={22} r={r} fill="none" stroke="#f4f4f5" strokeWidth={5} />
      <circle cx={22} cy={22} r={r} fill="none" stroke="var(--primary)" strokeWidth={5} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, pct))} className="transition-[stroke-dashoffset] duration-700" />
      <text x={22} y={22} transform="rotate(90 22 22)" textAnchor="middle" dominantBaseline="central" className="fill-zinc-800" style={{ fontSize: 11, fontWeight: 600 }}>
        {Math.round(pct * 100)}%
      </text>
    </svg>
  );
}

/** The month at a glance: how far close has come, who closed it, and where each project's compute spend is heading. */
function Books({ data }: { data: DashboardData }) {
  const m = data.metrics;
  const b = data.budgets;
  if (!m.lineCount) return null;
  const byYou = Math.max(0, m.completedReconciliations - m.autoMatched);
  return (
    <div className="mt-5 space-y-2 px-2.5">
      <div className="flex items-center gap-3 rounded-xl bg-white p-3 ring-1 ring-zinc-200">
        <Donut pct={m.completedReconciliations / m.lineCount} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-zinc-800">{periodLabel(data.period, true)} close</div>
          <div className="text-[12px] text-zinc-500 tnum">
            {m.completedReconciliations} of {m.lineCount} lines closed · target {dateOnly(m.monthClose.target + "T00:00:00Z")}
          </div>
          <div className="mt-1 flex gap-3 text-[11.5px] text-zinc-500 tnum">
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-primary" />
              {m.autoMatched} by agents
            </span>
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-brand-ink" />
              {byYou} after your review
            </span>
          </div>
        </div>
      </div>
      {b.projects.length ? (
        <div className="rounded-xl bg-white p-3 ring-1 ring-zinc-200">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] font-medium text-zinc-800">Compute budgets</span>
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

function Home({ data, items, onOpen, onStart }: { data: DashboardData; items: Item[]; onOpen: (id: string) => void; onStart: () => void }) {
  const needs = items.filter((i) => groupOf(i) === "needs");
  const moving = items.filter((i) => groupOf(i) === "moving");
  const done = items.filter((i) => groupOf(i) === "done");
  const name = (data.actors["human.controller"]?.name ?? "").split(" ")[0];
  const [now] = useState(() => new Date());
  const minutes = Math.max(1, Math.ceil((needs.length * 12) / 60));
  const titles = items.map((i) => shortTitle(i, data.providers));
  const dup = (i: Item) => titles.filter((t) => t === shortTitle(i, data.providers)).length > 1;
  return (
    <div className="px-3 pt-6 pb-4">
      <div className="px-2.5">
        <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.015em] text-zinc-950">
          {greeting(now)}
          {name ? ", " + name : ""}
        </h2>
        <p className="mt-1 text-[13px] text-zinc-500">
          {needs.length
            ? needs.length + (needs.length === 1 ? " decision" : " decisions") + ", about " + minutes + " min"
            : moving.length
              ? "Nothing needs you. Agents are on " + moving.length + "."
              : "All clear for " + data.period + "."}
        </p>
        {needs.length ? (
          <button
            type="button"
            onClick={onStart}
            className="mt-4 flex h-10 w-full items-center justify-between rounded-xl bg-zinc-900 pr-2 pl-4 text-[13.5px] font-medium text-white transition-colors hover:bg-zinc-800"
          >
            Start reviewing
            <kbd className="grid h-6 place-items-center rounded-md bg-white/15 px-1.5 font-mono text-[11px] text-white/80">Enter</kbd>
          </button>
        ) : null}
      </div>
      <Books data={data} />
      <div className="mt-6">
        <Section title="Needs you" count={needs.length}>
          {needs.map((i) => (
            <TaskRow key={i.id} item={i} data={data} dup={dup(i)} onOpen={() => onOpen(i.id)} />
          ))}
        </Section>
        <Section title="In progress" count={moving.length}>
          {moving.map((i) => (
            <TaskRow key={i.id} item={i} data={data} dup={dup(i)} onOpen={() => onOpen(i.id)} />
          ))}
        </Section>
        <Section title="Done" count={done.length} collapsible>
          {done.map((i) => (
            <TaskRow key={i.id} item={i} data={data} dup={dup(i)} onOpen={() => onOpen(i.id)} />
          ))}
        </Section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ task */

function Working({ w }: { w: WorkspaceData }) {
  const here = w.agents.filter((a) => a.currentWorkItemId === w.item.id && a.status !== "idle");
  if (!here.length) return null;
  return (
    <div className="space-y-2">
      {here.map((a) => {
        const step = a.status === "working" ? agentSteps(a.agentId, a.runTools, "running").current : null;
        return (
          <div key={a.agentId} className="flex items-center gap-2.5 text-[13px] text-zinc-700">
            <AgentAvatar actorId={a.agentId} size="sm" />
            <span className="flex-1 truncate">{w.actors[a.agentId]?.name}</span>
            <span className="flex items-center gap-1.5 text-brand-ink">
              {a.status === "working" ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              {step?.verb ?? (a.status === "queued" ? "Up next" : "Working")}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function TaskView({ w, onDecided }: { w: WorkspaceData; onDecided: () => void }) {
  const decision = buildDecision(w);
  const record = (
    <Link href={"/investigations/" + w.item.id + "/record"} className="inline-flex items-center gap-0.5 hover:text-zinc-900">
      Full record <ArrowUpRight className="size-3" />
    </Link>
  );
  if (decision) {
    return (
      <div className="px-5 pt-5 pb-6">
        <DecisionCard key={w.item.id + (decision.approvalId ?? "q")} w={w} decision={decision} keys onDone={onDecided} footer={record} />
      </div>
    );
  }
  const o = outcomeOf(w);
  const busy = w.agents.some((a) => a.currentWorkItemId === w.item.id && a.status !== "idle");
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
      <Working w={w} />
      <div className="text-[12.5px] text-zinc-500">{record}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ chat */

function Linked({ text, onTask }: { text: string; onTask: (id: string) => void }) {
  const parts = text.split(/(WI-\d{4})/g);
  return (
    <>
      {parts.map((p, i) =>
        /^WI-\d{4}$/.test(p) ? (
          <button key={i} type="button" onClick={() => onTask(p)} className="rounded bg-zinc-100 px-1 font-mono text-[12px] text-zinc-700 hover:bg-accent hover:text-brand-ink">
            {p}
          </button>
        ) : (
          <span key={i}>{p}</span>
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
}: {
  messages: ChatMessage[];
  pending: boolean;
  onTask: (id: string) => void;
  /** Who answers, when it is one employee rather than the assistant. */
  speaker?: { actorId: string; name: string };
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending]);
  return (
    <div className="space-y-4 px-5 pt-5 pb-4">
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
            <Linked text={m.content} onTask={onTask} />
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
      <div ref={end} />
    </div>
  );
}

function Composer({ placeholder, onSend, disabled }: { placeholder: string; onSend: (text: string) => void; disabled: boolean }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
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
}: {
  f: FrameChatTarget;
  messages: ChatMessage[];
  pending: boolean;
  onAsk: (text: string) => void;
  onClose: () => void;
  onTask: (id: string) => void;
}) {
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
      <div className="min-h-0 flex-1 overflow-y-auto">
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
          <Thread messages={messages} pending={pending} onTask={onTask} speaker={{ actorId: f.actorId, name: f.agentName }} />
        ) : (
          <p className="px-5 pt-5 text-[13px] leading-relaxed text-zinc-500">Ask about this frame. {f.agentName.split(" ")[0]} answers from the records behind it.</p>
        )}
      </div>
      <div className="shrink-0 px-3 pt-2 pb-3">
        {!messages.length ? (
          <div className="mb-2 flex flex-wrap gap-1.5 px-0.5">
            {frameSuggestions(f).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onAsk(s)}
                className="rounded-full px-2.5 py-1 text-[12px] text-zinc-500 ring-1 ring-zinc-200 transition-colors hover:bg-zinc-50 hover:text-zinc-800"
              >
                {s}
              </button>
            ))}
          </div>
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

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [task]);

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
              <Home data={data} items={items} onOpen={onTask} onStart={() => needs[0] && onTask(needs[0].id)} />
            ) : mode === "chat" ? (
              <Thread messages={chat} pending={pending} onTask={(id) => { setChatOpen(false); onTask(id); }} />
            ) : ready ? (
              <TaskView w={ready} onDecided={onDecided} />
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
              <div className="mb-2 flex flex-wrap gap-1.5 px-0.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => ask(s)}
                    className="rounded-full px-2.5 py-1 text-[12px] text-zinc-500 ring-1 ring-zinc-200 transition-colors hover:bg-zinc-50 hover:text-zinc-800"
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
            {mode === "home" && chat.length ? (
              <button type="button" onClick={() => setChatOpen(true)} className="mb-2 px-1 text-[12px] text-zinc-500 hover:text-zinc-900">
                Continue chat ({chat.length})
              </button>
            ) : null}
            <Composer placeholder={task ? "Ask about this task" : "Ask about your books"} onSend={ask} disabled={pending} />
          </div>
        </>
      )}
    </aside>
  );
}

