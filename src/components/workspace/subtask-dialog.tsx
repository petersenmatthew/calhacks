"use client";

import { useState } from "react";
import { FileSpreadsheet, LoaderCircle, Terminal } from "lucide-react";
import { AGENT_STEPS, agentSteps } from "@/lib/agent-steps";
import { clockTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { JsonView } from "../json-view";
import { useLiveConnected } from "../live-events";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { useWorkspace } from "./workspace-context";

export type SubtaskSelection = { agentId: string; label: string; runId: string | null };

export function SubtaskDialog({ selection, onClose }: { selection: SubtaskSelection; onClose: () => void }) {
  const { data } = useWorkspace();
  const connected = useLiveConnected();
  const [selectedEvent, setSelectedEvent] = useState<number | null>(null);
  const [tab, setTab] = useState<"artifact" | "input">("artifact");
  const definition = AGENT_STEPS[selection.agentId]?.find(step => step.label === selection.label);
  // Keep the selected run stable: a retry must not replace the artifact being inspected.
  const run = selection.runId ? data.runs.find(r => r.id === selection.runId) : data.runs.find(r => r.agentId === selection.agentId);
  const runEvents = run ? data.activity.filter(e => e.runId === run.id) : [];
  const events = runEvents.filter(e => e.toolName && definition?.tools.includes(e.toolName));
  const event = events.find(e => e.id === selectedEvent) ?? events.at(-1);
  const state = agentSteps(selection.agentId, runEvents.flatMap(e => e.toolName ? [e.toolName] : []), run?.status === "running" || run?.status === "completed" || run?.status === "failed" ? run.status : "none").steps.find(s => s.label === selection.label)?.state;
  const working = run?.status === "running" && state === "active";
  const failed = run?.status === "failed";
  const status = failed ? "Run failed" : run?.status === "cancelled" ? "Run cancelled" : working ? "Working" : state === "done" ? events.length ? "Recorded" : "No tool activity recorded" : "Waiting";
  const evidence = data.evidence.filter(e => event?.evidenceIds.includes(e.id));
  const value = tab === "input" ? event?.args : event?.result;
  const records = Array.isArray(value) ? value : value && typeof value === "object" ? Object.entries(value).map(([field, value]) => ({ field, value })) : null;
  const columns = records ? [...new Set(records.flatMap(r => r && typeof r === "object" && !Array.isArray(r) ? Object.keys(r) : ["value"]))] : [];
  const display = (value: unknown) => value === null || value === undefined ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);

  return <Dialog open onOpenChange={open => !open && onClose()}>
    <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[980px]">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2"><FileSpreadsheet className="size-5 text-zinc-700"/>{selection.label}</DialogTitle>
        <DialogDescription>{data.actors[selection.agentId]?.name ?? selection.agentId} · {run ? `${run.id} · ${run.mode === "llm" ? "Agent execution" : "Deterministic demo"}` : "No run started"}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center justify-between gap-2 border-y py-2 text-xs">
        <span role="status" className={cn("flex items-center gap-2", failed ? "text-destructive" : working ? "text-zinc-700" : "text-zinc-500")}>{working && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none"/>}{status}</span>
        <span className="text-zinc-500">{events.length} tool events · {connected ? "Live updates connected" : "Live connection interrupted"}</span>
      </div>
      {failed && <p className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">{run?.error || "This run stopped before completing. Recorded outputs are preserved below."}</p>}
      <div className="grid min-w-0 gap-4 md:grid-cols-[240px_minmax(0,1fr)]">
        <section aria-label="Subtask activity" className="min-w-0">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-medium"><Terminal className="size-3.5"/>Tool activity</h3>
          <div className="max-h-80 space-y-2 overflow-y-auto">{events.map(e => <button key={e.id} onClick={() => setSelectedEvent(e.id)} aria-pressed={event?.id === e.id} className={cn("w-full rounded-lg border p-3 text-left", event?.id === e.id ? "border-primary bg-accent" : "border-zinc-200 hover:bg-zinc-50")}>
            <span className="block text-[10px] text-zinc-500">{clockTime(e.createdAt)} · {e.status}</span><span className="mt-1 block break-words text-xs font-medium">{e.title}</span><span className="mt-1 block break-all font-mono text-[10px] text-zinc-500">{e.toolName}</span>
          </button>)}</div>
          {!events.length && <p className="rounded-lg border border-dashed p-4 text-xs text-zinc-500">{working ? "Waiting for the first tool output. New records will appear here." : "No tool activity recorded for this subtask yet."}</p>}
          {selectedEvent !== null && <button onClick={() => setSelectedEvent(null)} className="mt-3 text-xs text-zinc-700 hover:underline">Follow latest output →</button>}
        </section>
        <section aria-label="Subtask artifact" className="min-w-0 overflow-hidden rounded-xl border bg-zinc-50">
          <div className="flex items-center justify-between gap-2 border-b bg-white px-3 py-2"><span className="text-xs font-medium">Working artifact</span><span className="text-[10px] text-zinc-500">{event ? clockTime(event.createdAt) : "Awaiting output"}</span></div>
          <div className="flex gap-1 border-b p-2">{(["artifact", "input"] as const).map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)} className={cn("rounded-md px-3 py-1 text-xs", tab === t ? "bg-white shadow-sm" : "text-zinc-500")}>{t === "artifact" ? "Output preview" : "Tool input"}</button>)}</div>
          <div className="max-h-80 overflow-auto">
            {records?.length ? <table className="w-full border-collapse text-left text-xs"><caption className="sr-only">{tab === "input" ? "Tool input" : "Tool output"} for {event?.title}</caption><thead className="sticky top-0 bg-zinc-100"><tr><th className="border-b border-r p-2 font-normal text-zinc-400">#</th>{columns.map(c => <th key={c} className="border-b border-r p-2 font-medium">{c}</th>)}</tr></thead><tbody>{records.map((r, i) => <tr key={i} className="bg-white"><td className="border-b border-r p-2 font-mono text-zinc-400">{i + 1}</td>{columns.map(c => <td key={c} className="min-w-24 max-w-96 whitespace-pre-wrap break-words border-b border-r p-2 align-top">{display(r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>)[c] : r)}</td>)}</tr>)}</tbody></table> : value !== undefined && value !== null ? <JsonView value={value} className="m-3"/> : <div className="p-8 text-center text-xs text-zinc-500"><FileSpreadsheet className="mx-auto mb-3 size-8 text-zinc-300"/>{event ? "No payload was recorded for this event." : "The agent’s output will appear here when this subtask runs."}</div>}
          </div>
          {event?.summary && <p className="border-t p-3 text-xs text-zinc-600">{event.summary}</p>}
        </section>
      </div>
      {evidence.length > 0 && <section><h3 className="mb-2 text-xs font-medium">Supporting evidence</h3><div className="space-y-2">{evidence.map(e => <details key={e.id} className="rounded-lg border p-3"><summary className="cursor-pointer text-xs">{e.label} <span className="text-zinc-400">· {e.sourceType} · {e.sourceId}</span></summary><JsonView value={e.snapshot} className="mt-3 max-h-48"/></details>)}</div></section>}
      <p className="text-[11px] text-zinc-400">Showing recorded tool activity and outputs. Opening this view does not start or rerun a task.</p>
    </DialogContent>
  </Dialog>;
}
