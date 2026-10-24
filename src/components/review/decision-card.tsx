"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowRight, Check, ChevronRight, CornerDownLeft, LoaderCircle } from "lucide-react";
import { AGENT_SHORT } from "@/lib/agent-steps";
import { postJson } from "@/lib/api";
import { money } from "@/lib/format";
import type { Choice, Decision } from "@/lib/decision";
import { cn } from "@/lib/utils";
import type { WorkspaceData } from "@/server/queries";
import { AgentAvatar } from "../status";
import { ProofView, SplitBar, TONE_BG } from "./proof";

function typing(t: EventTarget | null) {
  return t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

function Kbd({ children, dark }: { children: ReactNode; dark?: boolean }) {
  return (
    <kbd
      className={cn(
        "grid h-5 min-w-5 place-items-center rounded-[5px] px-1 font-mono text-[10.5px] leading-none",
        dark ? "bg-white/15 text-white/80" : "bg-zinc-100 text-zinc-500 ring-1 ring-zinc-200/80",
      )}
    >
      {children}
    </kbd>
  );
}

export function doneMessage(d: Decision, c: Choice | null, w: WorkspaceData) {
  const agent = AGENT_SHORT[d.askedBy] ?? "the agents";
  if (!c) return d.custom === "answer" ? "Sent. " + agent + " picks it back up." : "Sent back to " + agent + " with your note.";
  if (c.action.type === "answer") return c.label + " it is. " + agent + " picks it back up.";
  if (c.action.type === "approve") {
    if (d.kind === "dispute") return "Dispute filed. Vendor Liaison writes to " + (w.providers[w.item.providerId]?.shortName ?? "the vendor") + ".";
    if (d.kind === "rule") return "Rule adopted. Similar cases book on their own.";
    return "Approved. The ledger gateway posts it.";
  }
  if (c.action.type === "changes" && c.action.directive) return "Done. " + agent + " redoes the split, and the agents propose a rule for next time.";
  return "Sent back to " + agent + ".";
}

/** Records a decision: a choice, or free text (a different instruction, or an answer to a question). */
export async function submitDecision(
  w: WorkspaceData,
  decision: Decision,
  choice: Choice | null,
  text?: string,
  budget?: { projectId: string; monthlyCents: number } | null,
) {
  if (choice?.action.type === "answer" || (!choice && decision.custom === "answer")) {
    const answer = choice?.action.type === "answer" ? [choice.action.answer, text].filter(Boolean).join(" ") : (text ?? "");
    await postJson("/api/work-items/" + w.item.id + "/info", { answer });
  } else if (decision.approvalId) {
    const a = choice?.action;
    // "Yes, but": whatever the controller added rides along with the option they picked.
    const reason = !a ? text : a.type === "reject" || a.type === "changes" ? [a.reason, text].filter(Boolean).join(" ") : (text ?? null);
    await postJson("/api/approvals/" + decision.approvalId, {
      decision: !a ? "CHANGES_REQUESTED" : a.type === "approve" ? "APPROVED" : a.type === "reject" ? "REJECTED" : "CHANGES_REQUESTED",
      reason,
      directive: a?.type === "changes" ? (a.directive ?? null) : null,
      budget: a?.type === "approve" && budget ? { projectId: budget.projectId, monthlyCents: budget.monthlyCents } : null,
    });
  }
}

/**
 * A decision as a few large, obvious choices. Number keys pick a choice when
 * keys is on. After a choice lands, the card shows one calm line and calls onDone.
 */
export function DecisionCard({
  w,
  decision,
  size = "sm",
  proof = true,
  keys = false,
  onDone,
  footer,
}: {
  w: WorkspaceData;
  decision: Decision;
  size?: "sm" | "lg";
  proof?: boolean;
  keys?: boolean;
  onDone?: () => void;
  footer?: ReactNode;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  // With nothing to pick from, the answer box is the whole decision.
  const [custom, setCustom] = useState(decision.choices.length === 0 && decision.custom !== null);
  const [note, setNote] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const lg = size === "lg";

  const send = async (choice: Choice | null, text?: string) => {
    if (busy || done) return;
    setBusy(choice?.id ?? "custom");
    try {
      await submitDecision(w, decision, choice, text);
      setDone(doneMessage(decision, choice, w));
      onDone?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const latest = useRef({ send, choices: decision.choices });
  useEffect(() => {
    latest.current = { send, choices: decision.choices };
  });
  useEffect(() => {
    if (!keys) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const i = Number(e.key) - 1;
      const c = latest.current.choices[i];
      if (Number.isInteger(i) && c) {
        e.preventDefault();
        void latest.current.send(c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys]);

  useEffect(() => {
    if (custom) input.current?.focus();
  }, [custom]);

  return (
    <div className={cn("animate-enter", lg ? "space-y-7" : "space-y-5")}>
      <header>
        <div className="flex items-center gap-1.5 text-[12px] text-zinc-500">
          <AgentAvatar actorId={decision.askedBy} size="sm" />
          <span className="truncate">{decision.context}</span>
        </div>
        <h2 className={cn("mt-3 font-semibold tracking-[-0.015em] text-balance text-zinc-950", lg ? "text-[26px] leading-[1.15]" : "text-[19px] leading-[1.25]")}>
          {decision.title}
        </h2>
        <p className={cn("mt-1.5 text-zinc-500", lg ? "text-[15px]" : "text-[13px]")}>{decision.ask}</p>
      </header>

      {proof && decision.proof ? <ProofView proof={decision.proof} size={size} /> : null}

      {done ? (
        <div className="animate-enter flex items-start gap-2.5 rounded-xl bg-accent/70 px-4 py-3.5">
          <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
            <Check className="size-3" strokeWidth={3} />
          </span>
          <span className={cn("leading-snug text-zinc-800", lg ? "text-[14px]" : "text-[13px]")}>{done}</span>
        </div>
      ) : decision.kind === "split" ? (
        <div className="grid gap-2">
          {decision.choices.map((c, i) => (
            <button
              key={c.id}
              type="button"
              disabled={busy !== null}
              onClick={() => send(c)}
              className={cn(
                "group relative rounded-xl bg-white p-3.5 text-left ring-1 transition-[box-shadow,background-color] ring-inset disabled:opacity-60",
                c.primary ? "ring-2 ring-zinc-900" : "ring-zinc-200 hover:ring-zinc-400",
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn("font-medium text-zinc-900", lg ? "text-[15px]" : "text-[14px]")}>{c.label}</span>
                {c.tag ? <span className={cn("rounded-full px-1.5 py-px text-[10.5px] font-medium", c.primary ? "bg-accent text-brand-ink" : "bg-zinc-100 text-zinc-500")}>{c.tag}</span> : null}
                <span className="ml-auto">{busy === c.id ? <LoaderCircle className="size-4 animate-spin text-zinc-400" /> : keys ? <Kbd>{i + 1}</Kbd> : null}</span>
              </div>
              {c.split ? (
                <>
                  <SplitBar segments={c.split} className="mt-3" />
                  <div className="mt-2.5 space-y-1">
                    {c.split.map((s) => (
                      <div key={s.key} className={cn("flex items-center gap-2 text-zinc-600", lg ? "text-[13px]" : "text-[12px]")}>
                        <span className={cn("size-2 rounded-full", TONE_BG[s.tone])} />
                        <span className="flex-1 truncate">{s.label}</span>
                        <span className="font-medium text-zinc-800 tnum">{money(s.value, { cents: false })}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </button>
          ))}
        </div>
      ) : decision.kind === "owner" ? (
        <div className="overflow-hidden rounded-xl ring-1 ring-zinc-200">
          {decision.choices.map((c, i) => (
            <button
              key={c.id}
              type="button"
              disabled={busy !== null}
              onClick={() => send(c)}
              className={cn(
                "group flex w-full items-center gap-3 border-t border-zinc-100 bg-white px-3.5 text-left first:border-t-0 hover:bg-zinc-50 disabled:opacity-60",
                lg ? "h-14" : "h-12",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate font-medium text-zinc-900", lg ? "text-[15px]" : "text-[13.5px]")}>{c.label}</span>
                {c.hint ? <span className="block truncate text-[11.5px] text-zinc-500">{c.hint}</span> : null}
              </span>
              {busy === c.id ? (
                <LoaderCircle className="size-4 animate-spin text-zinc-400" />
              ) : keys ? (
                <Kbd>{i + 1}</Kbd>
              ) : (
                <ArrowRight className="size-4 text-zinc-300 transition-colors group-hover:text-zinc-500" />
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="grid gap-2">
          {decision.choices.map((c, i) => (
            <button
              key={c.id}
              type="button"
              disabled={busy !== null}
              onClick={() => send(c)}
              className={cn(
                "flex w-full items-center gap-2 rounded-xl px-4 text-left transition-colors disabled:opacity-60",
                lg ? "h-14" : "h-12",
                c.primary ? "bg-zinc-900 text-white hover:bg-zinc-800" : "bg-white text-zinc-900 ring-1 ring-zinc-200 ring-inset hover:bg-zinc-50 hover:ring-zinc-300",
              )}
            >
              <span className={cn("font-medium", lg ? "text-[15px]" : "text-[14px]")}>{c.label}</span>
              {c.hint ? <span className={cn("truncate", lg ? "text-[13px]" : "text-[12px]", c.primary ? "text-white/55" : "text-zinc-400")}>{c.hint}</span> : null}
              <span className="ml-auto">
                {busy === c.id ? <LoaderCircle className="size-4 animate-spin opacity-70" /> : keys ? <Kbd dark={c.primary}>{i + 1}</Kbd> : null}
              </span>
            </button>
          ))}
        </div>
      )}

      {!done && custom ? (
        <form
          className="animate-enter flex items-center gap-1.5 rounded-xl bg-white pr-1.5 pl-3.5 ring-1 ring-zinc-300 focus-within:ring-zinc-500"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim().length >= 3) void send(null, note.trim());
          }}
        >
          <input
            ref={input}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCustom(false);
            }}
            placeholder={decision.custom === "answer" ? "Your answer" : "What should change?"}
            className="h-11 min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-zinc-400"
          />
          <button
            type="submit"
            disabled={note.trim().length < 3 || busy !== null}
            aria-label="Send"
            className="grid size-8 place-items-center rounded-lg bg-zinc-900 text-white disabled:bg-zinc-200 disabled:text-zinc-400"
          >
            {busy === "custom" ? <LoaderCircle className="size-3.5 animate-spin" /> : <CornerDownLeft className="size-3.5" />}
          </button>
        </form>
      ) : null}

      {!done ? (
        <div className="flex items-center gap-4 text-[12.5px] text-zinc-500">
          {decision.why.length ? (
            <button type="button" onClick={() => setWhy(!why)} className="flex items-center gap-1 hover:text-zinc-900">
              <ChevronRight className={cn("size-3.5 transition-transform", why && "rotate-90")} />
              Why
            </button>
          ) : null}
          {decision.custom && !custom ? (
            <button type="button" onClick={() => setCustom(true)} className="hover:text-zinc-900">
              Something else
            </button>
          ) : null}
          {footer ? <span className="ml-auto">{footer}</span> : null}
        </div>
      ) : footer ? (
        <div className="text-[12.5px] text-zinc-500">{footer}</div>
      ) : null}

      {!done && why ? (
        <ul className="animate-enter -mt-2 space-y-1.5 border-l-2 border-zinc-100 pl-3">
          {decision.why.map((line) => (
            <li key={line} className={cn("leading-snug text-zinc-600", lg ? "text-[13.5px]" : "text-[12.5px]")}>
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

