"use client";

import { clockTime } from "@/lib/format";
import { JsonView } from "../json-view";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { SIMULATED_SOURCES, useWorkspace } from "./workspace-context";

export function EvidenceDialog({ evidenceId, onClose }: { evidenceId: string | null; onClose: () => void }) {
  const { data } = useWorkspace();
  const ev = evidenceId ? data.evidence.find((e) => e.id === evidenceId) : null;
  return (
    <Dialog open={Boolean(ev)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[680px]">
        {ev ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-muted-foreground">{ev.id}</span>
                {ev.label}
              </DialogTitle>
              <DialogDescription>
                {SIMULATED_SOURCES.has(ev.sourceType) ? "Simulated source record" : "Derived record"} · {ev.sourceType} {ev.sourceId} · collected by{" "}
                {data.actors[ev.collectedBy]?.name ?? ev.collectedBy} at {clockTime(ev.createdAt)}
                {ev.runId ? " in " + ev.runId : ""}
              </DialogDescription>
            </DialogHeader>
            <JsonView value={ev.snapshot} className="max-h-[60vh]" />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function EvidenceChips({ ids, max = 8 }: { ids: string[]; max?: number }) {
  const { data, openEvidence } = useWorkspace();
  if (!ids.length) return null;
  const shown = ids.slice(0, max);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((id) => {
        const ev = data.evidence.find((e) => e.id === id);
        return (
          <button
            key={id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openEvidence(id);
            }}
            className="inline-flex max-w-[220px] items-center gap-1 rounded border bg-white px-1.5 py-0.5 text-[10.5px] text-zinc-600 hover:border-zinc-400 hover:text-zinc-900"
            title={ev?.label ?? id}
          >
            <span className="font-mono text-zinc-400">{id}</span>
            <span className="truncate">{ev?.label ?? ""}</span>
          </button>
        );
      })}
      {ids.length > max ? <span className="text-[10.5px] text-muted-foreground">+{ids.length - max} more</span> : null}
    </div>
  );
}
