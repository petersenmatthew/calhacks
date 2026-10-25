"use client";

import { useState } from "react";
import { Mail, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkspaceData } from "@/server/queries";

type Dispute = NonNullable<WorkspaceData["dispute"]>;

const STATUS: Record<string, { label: string; className: string }> = {
  queued: { label: "Sending", className: "bg-zinc-100 text-zinc-600" },
  retrying: { label: "Retrying", className: "bg-zinc-100 text-zinc-600" },
  sent: { label: "Emailed", className: "bg-accent text-brand-ink" },
  simulated: { label: "Recorded", className: "bg-zinc-100 text-zinc-600" },
  failed: { label: "Email failed", className: "bg-destructive/10 text-destructive" },
  bounced: { label: "Bounced", className: "bg-destructive/10 text-destructive" },
};

/**
 * The dispute exactly as it went to the provider, shown like an email: who it went to,
 * the subject, and the first few lines of the letter. Expands to the full letter and evidence.
 */
export function DisputeLetter({ dispute, defaultOpen = false, className }: { dispute: Dispute; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!dispute.letterBody) return null;
  const [letter, ...rest] = dispute.letterBody.split("\n\nEVIDENCE\n");
  const evidence = rest.join("\n\nEVIDENCE\n");
  const status = STATUS[dispute.emailStatus ?? "queued"] ?? STATUS.queued;
  // "[LAMBDA-CASE-6002] Dispute ..." reads better as a case tag plus a plain subject.
  const m = (dispute.letterSubject ?? "").match(/^\[([^\]]+)\]\s*(.*)$/);
  const caseRef = m?.[1] ?? null;
  const subject = m?.[2] || dispute.letterSubject || "Billing dispute";
  return (
    <div className={cn("overflow-hidden rounded-2xl bg-white ring-1 ring-zinc-200", className)}>
      <div className="flex items-center gap-2 px-4 pt-3 text-[11.5px] text-zinc-500">
        <Mail className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          To <span className="text-zinc-700">{dispute.sentTo}</span>
        </span>
        <span className={cn("ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium", status.className)}>{status.label}</span>
      </div>
      <div className="px-4 pt-1.5">
        <div className="text-[13.5px] leading-snug font-semibold text-zinc-950">{subject}</div>
        {caseRef ? <div className="mt-0.5 font-mono text-[10.5px] text-zinc-400">{caseRef}</div> : null}
      </div>
      <div className="relative px-4 pt-2.5 pb-3">
        <div className={cn("space-y-1.5 text-[12.5px] leading-relaxed text-zinc-700", !open && "max-h-[7.4em] overflow-hidden")}>
          {letter.split(/\n{2,}/).map((para, i) => (
            <p key={i} className="whitespace-pre-line">
              {para}
            </p>
          ))}
        </div>
        {!open ? <div className="pointer-events-none absolute inset-x-0 bottom-3 h-8 bg-gradient-to-t from-white to-transparent" /> : null}
        {open && evidence ? (
          <pre className="mt-3 overflow-x-auto rounded-xl bg-zinc-50 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-zinc-700">
            {"EVIDENCE\n" + evidence}
          </pre>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t border-zinc-100 px-4 py-2">
        <button type="button" onClick={() => setOpen(!open)} className="text-[12px] font-medium text-zinc-700 hover:text-zinc-950">
          {open ? "Show less" : "Read full email"}
        </button>
        <span className="ml-auto flex items-center gap-1 rounded-full bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-500 ring-1 ring-zinc-200/70">
          <Paperclip className="size-3" /> {dispute.id}-evidence.csv
        </span>
      </div>
    </div>
  );
}
