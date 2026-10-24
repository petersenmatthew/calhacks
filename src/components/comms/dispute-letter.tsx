"use client";

import { useState } from "react";
import { ChevronDown, Mail, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkspaceData } from "@/server/queries";

type Dispute = NonNullable<WorkspaceData["dispute"]>;

const STATUS: Record<string, { label: string; className: string }> = {
  queued: { label: "Sending", className: "bg-zinc-100 text-zinc-600" },
  retrying: { label: "Retrying", className: "bg-zinc-100 text-zinc-600" },
  sent: { label: "Emailed", className: "bg-accent text-brand-ink" },
  simulated: { label: "Recorded", className: "bg-zinc-100 text-zinc-600" },
  failed: { label: "Email failed", className: "bg-destructive/10 text-destructive" },
};

/** The dispute exactly as it went to the provider: recipient, subject, letter, evidence, attachment. */
export function DisputeLetter({ dispute, defaultOpen = false, className }: { dispute: Dispute; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!dispute.letterBody) return null;
  const [letter, ...rest] = dispute.letterBody.split("\n\nEVIDENCE\n");
  const evidence = rest.join("\n\nEVIDENCE\n");
  const status = STATUS[dispute.emailStatus ?? "queued"] ?? STATUS.queued;
  return (
    <div className={cn("rounded-xl ring-1 ring-zinc-200", className)}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left">
        <Mail className="mt-0.5 size-4 shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-zinc-900">{dispute.letterSubject}</span>
          <span className="block truncate text-[11.5px] text-zinc-500">To {dispute.sentTo}</span>
        </span>
        <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium", status.className)}>{status.label}</span>
        <ChevronDown className={cn("mt-0.5 size-3.5 shrink-0 text-zinc-400 transition-transform", !open && "-rotate-90")} />
      </button>
      {open ? (
        <div className="space-y-3 border-t border-zinc-100 px-3 py-3">
          <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-zinc-800">{letter}</p>
          {evidence ? (
            <pre className="overflow-x-auto rounded-lg bg-zinc-50 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-zinc-700 ring-1 ring-zinc-200/70">
              {"EVIDENCE\n" + evidence}
            </pre>
          ) : null}
          <div className="flex items-center gap-1.5 text-[11.5px] text-zinc-500">
            <Paperclip className="size-3.5" /> {dispute.id}-evidence.csv
          </div>
        </div>
      ) : null}
    </div>
  );
}
