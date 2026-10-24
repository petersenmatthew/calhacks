"use client";

import { useState } from "react";
import useSWR from "swr";
import { ArrowUpRight, ChevronDown, LoaderCircle, Mail, MessageSquare, X } from "lucide-react";
import { agentSteps } from "@/lib/agent-steps";
import { fetcher, postJson } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import type { AgentView } from "@/server/queries";
import { useLiveRefresh } from "../live-events";
import { AgentAvatar, StateBadge } from "../status";

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="border-t px-5 py-4">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-[12px] font-medium text-zinc-500">
        {title}
        {count !== undefined ? <span className="font-mono text-zinc-400 tnum">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function StatusLine({ view }: { view: AgentView }) {
  const s = view.status;
  if (view.settings.paused) {
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] text-zinc-500">
        <span className="size-1.5 rounded-full bg-zinc-400" />
        Paused{s?.queued ? " · " + s.queued + " waiting" : ""}
      </span>
    );
  }
  if (s?.status === "working") {
    const step = agentSteps(view.id, s.runTools, "running").current;
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] text-brand-ink">
        <LoaderCircle className="size-3.5 animate-spin" />
        {step?.verb ?? "Working"} on {s.currentWorkItemId}
      </span>
    );
  }
  if (s?.status === "queued") {
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] text-zinc-600">
        <span className="size-1.5 rounded-full bg-amber-400" />
        {s.queued} waiting
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-[12.5px] text-zinc-500">
      <span className="size-1.5 rounded-full bg-zinc-300" />
      Idle
    </span>
  );
}

function Guidance({ view, onSaved }: { view: AgentView; onSaved: (v: AgentView) => void }) {
  const [text, setText] = useState(view.settings.guidance);
  const [saving, setSaving] = useState(false);
  const dirty = text.trim() !== view.settings.guidance;
  const replay = view.execution.mode !== "llm";
  return (
    <div>
      <label htmlFor={"guidance-" + view.id} className="sr-only">
        Guidance
      </label>
      <p className="text-[11.5px] leading-snug text-zinc-500">
        Added to its instructions on live LLM runs.{replay ? " Not used in deterministic replay." : ""}
      </p>
      <textarea
        id={"guidance-" + view.id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="e.g. Always cite the contract clause by number."
        className="mt-2 w-full resize-none rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-[12.5px] leading-snug outline-none placeholder:text-zinc-400 focus:border-zinc-400"
      />
      {dirty ? (
        <div className="mt-1.5 flex justify-end gap-1.5">
          <button type="button" onClick={() => setText(view.settings.guidance)} className="h-7 rounded-md px-2.5 text-[12px] text-zinc-600 hover:bg-zinc-100">
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                onSaved(await postJson<AgentView>("/api/agents/" + view.id, { guidance: text }));
              } finally {
                setSaving(false);
              }
            }}
            className="h-7 rounded-md bg-zinc-900 px-2.5 text-[12px] font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Right sidebar for one employee: what it is, its settings, the tasks it worked on,
 * what it produced, and the tools it may use.
 */
export function AgentPanel({
  actorId,
  currentItemId,
  onClose,
  openOutput,
  onOpenTask,
}: {
  actorId: string;
  currentItemId?: string;
  onClose: () => void;
  /** Zooms to the output's frame when it is on the canvas; returns false otherwise. */
  openOutput: (activityId: number, workItemId: string | null) => boolean;
  /** Focuses a task on the canvas. */
  onOpenTask: (id: string) => void;
}) {
  const { data: view, mutate } = useSWR<AgentView>("/api/agents/" + actorId, fetcher, { keepPreviousData: true });
  useLiveRefresh(() => mutate(), undefined, 400);
  const now = useNow();
  const [toolsOpen, setToolsOpen] = useState(false);

  return (
    <div className="animate-enter flex h-full min-h-0 flex-col">
      {!view ? (
        <div className="p-5 text-[13px] text-zinc-500">Loading...</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <header className="px-5 pt-5 pb-4">
            <div className="flex items-start gap-3">
              <AgentAvatar actorId={view.id} size="lg" />
              <div className="min-w-0 flex-1">
                <h2 className="text-[17px] leading-tight font-semibold tracking-tight text-zinc-900">{view.name}</h2>
                <div className="mt-1">
                  <StatusLine view={view} />
                </div>
              </div>
              <button type="button" aria-label="Close" onClick={onClose} className="-mt-1 -mr-1 grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100">
                <X className="size-4" />
              </button>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-zinc-600">{view.description}</p>
          </header>

          <Section title="Connections" count={view.connections.length}>
            {view.connections.length ? (
              <ul className="space-y-2.5">
                {view.connections.map((c) => (
                  <li key={c.id} className="flex items-center gap-2.5" title={c.tools.join(", ")}>
                    {c.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.logo} alt="" className={cn("size-7 shrink-0 rounded-md ring-1 ring-zinc-200", !c.uses && "opacity-50 grayscale")} />
                    ) : (
                      <span className={cn("grid size-7 shrink-0 place-items-center rounded-md bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200", !c.uses && "opacity-50")}>
                        {c.id === "email" ? <Mail className="size-3.5" /> : <MessageSquare className="size-3.5" />}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-[12.5px]", c.uses ? "text-zinc-800" : "text-zinc-500")}>{c.name}</span>
                      <span className="block truncate text-[11px] text-zinc-400">{c.kind}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[11px] text-zinc-600">{c.read && c.write ? "Reads, writes" : c.write ? "Writes" : "Reads"}</span>
                      <span className="block font-mono text-[10.5px] text-zinc-400 tnum">
                        {c.uses ? c.uses + (c.uses === 1 ? " call" : " calls") + (c.lastAt ? " · " + relativeTime(c.lastAt, now) : "") : "not used yet"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-zinc-500">Works only inside the app.</p>
            )}
          </Section>

          <Section title="Guidance">
            <Guidance key={view.id + ":" + view.settings.guidance} view={view} onSaved={(v) => mutate(v, { revalidate: false })} />
          </Section>

          <Section title="Tasks" count={view.tasks.length}>
            {view.tasks.length ? (
              <ul className="-mx-2 space-y-0.5">
                {view.tasks.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => onOpenTask(t.id)}
                      className={cn("group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-zinc-50", t.id === currentItemId && "bg-accent/60")}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] text-zinc-800">{t.title}</span>
                        <span className="font-mono text-[10.5px] text-zinc-400">
                          {t.id} · {t.runs} run{t.runs === 1 ? "" : "s"}
                        </span>
                      </span>
                      <StateBadge state={t.state} className="text-[11px] text-zinc-500" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-zinc-500">No tasks yet.</p>
            )}
          </Section>

          <Section title="Outputs" count={view.outputs.length}>
            {view.outputs.length ? (
              <ul className="-mx-2 space-y-0.5">
                {view.outputs.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (!openOutput(o.id, o.workItemId) && o.workItemId) onOpenTask(o.workItemId);
                      }}
                      className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-zinc-50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-2 text-[12.5px] leading-snug text-zinc-800">{o.title}</span>
                        <span className="font-mono text-[10.5px] text-zinc-400">
                          {o.workItemId ?? "System"} · {relativeTime(o.at, now)}
                        </span>
                      </span>
                      {o.workItemId && o.workItemId !== currentItemId ? <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-zinc-400" /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-zinc-500">Nothing produced yet.</p>
            )}
          </Section>

          <Section title="Tools" count={view.tools.length}>
            <button type="button" onClick={() => setToolsOpen(!toolsOpen)} className="flex items-center gap-1 text-[12px] text-zinc-600 hover:text-zinc-900">
              <ChevronDown className={cn("size-3.5 transition-transform", !toolsOpen && "-rotate-90")} />
              {toolsOpen ? "Hide" : "Show"} what it can do
            </button>
            {toolsOpen ? (
              <ul className="mt-2.5 space-y-2">
                {view.tools.map((t) => (
                  <li key={t.name}>
                    <div className="font-mono text-[11.5px] text-zinc-800">{t.name}</div>
                    <div className="text-[11.5px] leading-snug text-zinc-500">{t.description}</div>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
        </div>
      )}
    </div>
  );
}
