"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { doneMessage, submitDecision } from "./decision-card";
import { ProofView, SplitBar, TONE_BG } from "./proof";

/** One message in a decision conversation. Agent replies may carry the option the controller picked in words. */
export type TalkTurn = { role: "user" | "assistant"; content: string; choiceId?: string | null; note?: string | null; budget?: BudgetChange | null };

function typing(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

function Typed({ text }: { text: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const next = Math.min(text.length, Math.floor(((now - start) / 1000) * 110));
      setShown(next);
      if (next < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]);
  return <>{text.slice(0, shown)}</>;
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
  onSomethingElse,
  onDone,
  footer,
}: {
  w: WorkspaceData;
  decision: Decision;
  turns: TalkTurn[];
  pending: boolean;
  /** Focus the chat box to say something that is not one of the suggestions. */
  onSomethingElse: () => void;
  onDone: () => void;
  footer?: ReactNode;
}) {
  const [opener, setOpener] = useState<string | null>(null);
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
        [doneMessage(decision, choice, w), budget ? "Budget Analyst sets " + budget.projectName + " to " + money(budget.monthlyCents) + " a month." : null]
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
  const latest = useRef({ act, choices: decision.choices });
  useEffect(() => {
    latest.current = { act, choices: decision.choices };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
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
        {opener ? <Typed text={opener} /> : <Dots />}
      </div>

      {!done ? (
        decision.kind === "split" ? (
          <div className="grid gap-1.5">
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
            {decision.custom ? (
              <button type="button" onClick={onSomethingElse} className="justify-self-start rounded-full px-3 py-1.5 text-[12.5px] text-zinc-500 ring-1 ring-zinc-200 ring-inset hover:text-zinc-900">
                Something else
              </button>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {decision.choices.map((c) => (
              <button
                key={c.id}
                type="button"
                disabled={busy !== null}
                onClick={() => act(c)}
                title={c.hint}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium ring-1 ring-inset transition-colors disabled:opacity-60",
                  c.primary ? "bg-zinc-900 text-white ring-zinc-900 hover:bg-zinc-800" : "bg-white text-zinc-800 ring-zinc-200 hover:ring-zinc-400",
                )}
              >
                {c.label}
                {c.hint ? <span className="font-normal opacity-55">{c.hint}</span> : null}
                {busy === c.id ? <LoaderCircle className="size-3.5 animate-spin opacity-70" /> : null}
              </button>
            ))}
            {decision.custom ? (
              <button type="button" onClick={onSomethingElse} className="inline-flex h-8 items-center rounded-full px-3 text-[13px] text-zinc-500 ring-1 ring-zinc-200 ring-inset hover:text-zinc-900">
                Something else
              </button>
            ) : null}
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
            <span className="whitespace-pre-wrap">{t.content}</span>
            {!done && i === lastAgent && !dismissed.includes(i) && (t.choiceId || t.note) ? (
              <ConfirmRow
                label={
                  t.choiceId
                    ? (decision.choices.find((x) => x.id === t.choiceId)?.label ?? "")
                    : decision.custom === "answer"
                      ? "Send your answer"
                      : "Send back with your note"
                }
                extras={[
                  ...(t.choiceId && t.note ? ["Plus: " + t.note] : []),
                  ...(t.budget ? ["Set " + t.budget.projectName + " budget to " + money(t.budget.monthlyCents) + " a month"] : []),
                ]}
                busy={busy !== null}
                onConfirm={() => act(decision.choices.find((x) => x.id === t.choiceId) ?? null, t.note ?? undefined, t.budget)}
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

function ConfirmRow({
  label,
  extras,
  busy,
  onConfirm,
  onCancel,
}: {
  label: string;
  extras: string[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="animate-enter mt-2.5 flex items-center gap-1.5 rounded-xl bg-zinc-50 p-1.5 pl-3 ring-1 ring-zinc-200">
      <span className="min-w-0 flex-1 text-[12.5px] text-zinc-600">
        <span className="block truncate">{label}</span>
        {extras.map((x) => (
          <span key={x} className="block text-zinc-500">
            {x}
          </span>
        ))}
      </span>
      <button type="button" onClick={onCancel} disabled={busy} className="h-7 rounded-lg px-2.5 text-[12.5px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900">
        Not yet
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className="inline-flex h-7 items-center gap-1 rounded-lg bg-zinc-900 px-3 text-[12.5px] font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
      >
        {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" strokeWidth={2.5} />}
        Confirm
      </button>
    </div>
  );
}
