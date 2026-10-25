"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, LoaderCircle } from "lucide-react";
import { AGENT_SHORT } from "@/lib/agent-steps";
import { postJson } from "@/lib/api";
import { money } from "@/lib/format";
import type { Choice, Decision } from "@/lib/decision";
import { cn } from "@/lib/utils";
import type { WorkspaceData } from "@/server/queries";
import type { BudgetChange, DecisionTurn } from "@/server/assistant";
import { AgentAvatar } from "../status";
import { ContractLinked } from "../contract/contract-link";
import { doneMessage, submitDecision } from "./decision-card";
import { ProofView, SplitBar, TONE_BG } from "./proof";
import { looksLikeRule } from "@/lib/rule-intent";

/** One message in a decision conversation. Agent replies may carry the option the controller picked in words. */
export type TalkTurn = { role: "user" | "assistant"; content: string; choiceId?: string | null; note?: string | null; budget?: BudgetChange | null; rule?: boolean };

function typing(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

function Typed({ text, onDone, contractId }: { text: string; onDone?: () => void; contractId?: string | null }) {
  const [shown, setShown] = useState(0);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const next = Math.min(text.length, Math.floor(((now - start) / 1000) * 110));
      setShown(next);
      if (next < text.length) raf = requestAnimationFrame(tick);
      else done.current?.();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]);
  // Links appear once the line has finished typing.
  return shown >= text.length ? <ContractLinked text={text} contractId={contractId} /> : <>{text.slice(0, shown)}</>;
}

function Dots() {
  return (
    <span className="flex gap-1 py-1.5">
      {[0, 150, 300].map((d) => (
        <span key={d} className="size-1.5 animate-pulse rounded-full bg-zinc-300" style={{ animationDelay: d + "ms" }} />
      ))}
    </span>
  );
}

/**
 * A pending decision as a short conversation with the employee who asked for it:
 * one picture, its opening line, suggested answers, and whatever you say back in chat.
 * Answers given in words come back as a one-click confirmation.
 */
export function DecisionThread({
  w,
  decision,
  turns,
  pending,
  onDone,
}: {
  w: WorkspaceData;
  decision: Decision;
  turns: TalkTurn[];
  pending: boolean;
  onDone: () => void;
}) {
  const [opener, setOpener] = useState<string | null>(null);
  // Suggestions appear once the opening line has finished typing.
  const [typed, setTyped] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<number[]>([]);
  const name = w.actors[decision.askedBy]?.name ?? AGENT_SHORT[decision.askedBy] ?? "Agent";

  useEffect(() => {
    let live = true;
    postJson<DecisionTurn>("/api/work-items/" + w.item.id + "/discuss", { messages: [] })
      .then((r) => live && setOpener(r.reply))
      .catch(() => live && setOpener(decision.why[0] ?? decision.ask));
    return () => {
      live = false;
    };
    // One opening line per decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.item.id, decision.approvalId]);

  const act = async (choice: Choice | null, note?: string, budget?: BudgetChange | null) => {
    if (busy || done) return;
    setBusy(choice?.id ?? "note");
    try {
      await submitDecision(w, decision, choice, note, budget);
      setDone(
        [doneMessage(decision, choice, w), budget ? "Budget Analyst sets " + budget.projectName + " to " + money(budget.monthlyCents, { cents: false }) + " a month." : null]
          .filter(Boolean)
          .join(" "),
      );
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Number keys pick a suggestion.
  const latest = useRef({ act, choices: decision.choices, typed });
  useEffect(() => {
    latest.current = { act, choices: decision.choices, typed };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!latest.current.typed || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const c = latest.current.choices[Number(e.key) - 1];
      if (c) {
        e.preventDefault();
        void latest.current.act(c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const lastAgent = turns.findLastIndex((t) => t.role === "assistant");
  const speaker = (
    <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-zinc-500">
      <AgentAvatar actorId={decision.askedBy} size="sm" />
      {name}
    </div>
  );

  return (
    <div className="animate-enter space-y-4">
      <header>
        <div className="text-[12px] text-zinc-500">{decision.context}</div>
        <h2 className="mt-2 text-[19px] leading-[1.25] font-semibold tracking-[-0.015em] text-balance text-zinc-950">{decision.title}</h2>
      </header>

      {decision.proof ? <ProofView proof={decision.proof} /> : null}

      <div className="text-[13.5px] leading-relaxed text-zinc-800">
        {speaker}
        {opener ? <Typed text={opener} onDone={() => setTyped(true)} contractId={w.contract.id} /> : <Dots />}
      </div>

      {!done && typed ? (
        decision.kind === "split" ? (
          <div className="animate-enter grid gap-1.5">
            {decision.choices.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={busy !== null}
                onClick={() => act(c)}
                className={cn(
                  "rounded-xl bg-white px-3 py-2.5 text-left ring-1 ring-inset transition-shadow disabled:opacity-60",
                  c.primary ? "ring-2 ring-zinc-900" : "ring-zinc-200 hover:ring-zinc-400",
                )}
              >
                <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-900">
                  {c.label}
                  {c.tag ? <span className="rounded-full bg-zinc-100 px-1.5 py-px text-[10.5px] text-zinc-500">{c.tag}</span> : null}
                  {busy === c.id ? <LoaderCircle className="ml-auto size-3.5 animate-spin text-zinc-400" /> : null}
                </div>
                {c.split ? (
                  <>
                    <SplitBar segments={c.split} className="mt-2" />
                    <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-zinc-500">
                      {c.split.map((s) => (
                        <span key={s.key} className="flex items-center gap-1">
                          <span className={cn("size-1.5 rounded-full", TONE_BG[s.tone])} />
                          {s.label} <span className="font-medium text-zinc-700 tnum">{money(s.value, { cents: false })}</span>
                        </span>
                      ))}
                    </div>
                  </>
                ) : null}
              </button>
            ))}
          </div>
        ) : (
          <div className="animate-enter overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200">
            {decision.choices.map((c, i) => (
              <button
                key={c.id}
                type="button"
                disabled={busy !== null}
                onClick={() => act(c)}
                className="group flex w-full items-center gap-3 border-t border-zinc-100 px-3.5 py-2.5 text-left transition-colors first:border-t-0 hover:bg-zinc-50 disabled:opacity-60"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium text-zinc-900">{c.label}</span>
                  {c.hint ? <span className="block text-[12px] text-zinc-500">{c.hint[0].toUpperCase() + c.hint.slice(1)}</span> : null}
                </span>
                {c.primary && decision.choices.length > 1 ? <span className="rounded-full bg-accent px-2 py-0.5 text-[10.5px] font-medium text-brand-ink">Recommended</span> : null}
                {busy === c.id ? (
                  <LoaderCircle className="size-4 animate-spin text-zinc-400" />
                ) : (
                  <kbd className="grid h-5 min-w-5 place-items-center rounded-[5px] bg-zinc-100 px-1 font-mono text-[10.5px] text-zinc-500 ring-1 ring-zinc-200/80 transition-colors group-hover:bg-zinc-900 group-hover:text-white group-hover:ring-zinc-900">
                    {i + 1}
                  </kbd>
                )}
              </button>
            ))}
          </div>
        )
      ) : null}

      {turns.map((t, i) =>
        t.role === "user" ? (
          <div key={i} className="animate-enter flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md bg-zinc-100 px-3.5 py-2 text-[13.5px] leading-snug whitespace-pre-wrap text-zinc-900">{t.content}</div>
          </div>
        ) : (
          <div key={i} className="animate-enter text-[13.5px] leading-relaxed text-zinc-800">
            {speaker}
            <span className="whitespace-pre-wrap">
              <ContractLinked text={t.content} contractId={w.contract.id} />
            </span>
            {!done && i === lastAgent && !dismissed.includes(i) && (t.choiceId || t.note) ? (
              <ConfirmRow
                items={[
                  ...(t.choiceId
                    ? [
                        (() => {
                          const c = decision.choices.find((x) => x.id === t.choiceId);
                          return { actorId: decision.kind === "dispute" ? "agent.vendor" : decision.askedBy, text: c?.label ?? "", detail: c?.hint };
                        })(),
                      ]
                    : [{ actorId: decision.askedBy, text: decision.custom === "answer" ? "Send your answer" : "Send back with your note" }]),
                  ...(t.budget
                    ? [
                        {
                          actorId: "agent.budget",
                          text: t.budget.projectName + " budget",
                          from: t.budget.fromCents != null ? money(t.budget.fromCents, { cents: false }) : undefined,
                          to: money(t.budget.monthlyCents, { cents: false }) + "/mo",
                        },
                      ]
                    : []),
                  ...(t.choiceId && t.note
                    ? [
                        t.rule || looksLikeRule(t.note)
                          ? { actorId: "agent.policy", text: "Controls Lead drafts a rule for next time", detail: t.note + " You approve it before it applies." }
                          : { actorId: decision.askedBy, text: "Note", detail: t.note },
                      ]
                    : []),
                ]}
                busy={busy !== null}
                onConfirm={() =>
                  act(
                    decision.choices.find((x) => x.id === t.choiceId) ?? null,
                    t.note ?? (t.budget ? "Set the " + t.budget.projectName + " budget to " + money(t.budget.monthlyCents, { cents: false }) + " a month." : undefined),
                    t.budget,
                  )
                }
                onCancel={() => setDismissed((d) => [...d, i])}
              />
            ) : null}
          </div>
        ),
      )}
      {pending ? <Dots /> : null}

      {done ? (
        <div className="animate-enter flex items-start gap-2.5 rounded-xl bg-accent/70 px-4 py-3.5">
          <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
            <Check className="size-3" strokeWidth={3} />
          </span>
          <span className="text-[13px] leading-snug text-zinc-800">{done}</span>
        </div>
      ) : null}

    </div>
  );
}

type ConfirmItem = { actorId: string; text: string; detail?: string; from?: string; to?: string };

/** What happens on Confirm, one line per employee who will act, then the two buttons. */
function ConfirmRow({ items, busy, onConfirm, onCancel }: { items: ConfirmItem[]; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="animate-enter mt-3 overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200">
      <div className="px-3.5 pt-3 text-[11.5px] text-zinc-500">On confirm</div>
      <ul className="space-y-2.5 px-3.5 pt-2 pb-3">
        {items.map((x, i) => (
          <li key={i} className="flex items-center gap-2.5">
            <AgentAvatar actorId={x.actorId} size="md" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] leading-snug font-medium text-zinc-900">{x.text}</span>
              {x.to ? (
                <span className="block text-[12px] tnum">
                  {x.from ? <span className="text-zinc-400 line-through decoration-zinc-300">{x.from}</span> : null}
                  {x.from ? <span className="mx-1 text-zinc-300">→</span> : null}
                  <span className="font-semibold text-brand-ink">{x.to}</span>
                </span>
              ) : x.detail ? (
                <span className="block text-[12px] leading-snug text-zinc-500">{x.detail[0].toUpperCase() + x.detail.slice(1)}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex gap-1.5 border-t border-zinc-100 bg-zinc-50/70 p-1.5">
        <button type="button" onClick={onCancel} disabled={busy} className="h-8 rounded-lg px-3 text-[12.5px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900">
          Not yet
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-zinc-900 px-3 text-[12.5px] font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" strokeWidth={2.5} />}
          Confirm
        </button>
      </div>
    </div>
  );
}
