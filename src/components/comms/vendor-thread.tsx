"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CornerDownLeft, LoaderCircle } from "lucide-react";
import { postJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { WorkspaceData } from "@/server/queries";

type Message = WorkspaceData["vendorMessages"][number];

const STATUS: Record<string, { label: string; className: string }> = {
  new: { label: "Liaison reading", className: "bg-zinc-100 text-zinc-600" },
  waiting_on_controller: { label: "Needs you", className: "bg-primary text-primary-foreground" },
  handled: { label: "Handled", className: "bg-accent text-brand-ink" },
  ignored: { label: "After close", className: "bg-zinc-100 text-zinc-500" },
};

function when(iso: string) {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Bubble({ m, vendor }: { m: Message; vendor: string }) {
  const inbound = m.direction === "inbound";
  const status = inbound ? STATUS[m.status] : null;
  const body = inbound ? m.body : m.body.replace(/\n\nReference: [^]+$/, "");
  return (
    <div className={cn("rounded-xl px-3 py-2.5", inbound ? "bg-zinc-50 ring-1 ring-zinc-200/70" : "ml-6 bg-accent/50")}>
      <div className="flex items-center gap-2 text-[11.5px] text-zinc-500">
        <span className="shrink-0 font-medium whitespace-nowrap text-zinc-800">{inbound ? vendor : "Vendor Liaison"}</span>
        <span className="truncate">{inbound ? m.fromAddr : "to " + m.toAddr}</span>
        <span className="ml-auto shrink-0">{when(m.receivedAt)}</span>
        {status ? <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium", status.className)}>{status.label}</span> : null}
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed whitespace-pre-wrap text-zinc-800">{body}</p>
    </div>
  );
}

/** The vendor's replies and the Vendor Liaison's answers, plus a way to paste a reply that came in some other way. */
export function VendorThread({ w, className }: { w: WorkspaceData; className?: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const dispute = w.dispute;
  if (!dispute) return null;
  const vendor = w.providers[dispute.providerId]?.shortName ?? w.providers[dispute.providerId]?.name ?? "Vendor";
  const canPaste = dispute.status === "SUBMITTED" && w.item.state === "DISPUTED";
  if (!w.vendorMessages.length && !canPaste) return null;
  const send = async () => {
    setBusy(true);
    try {
      await postJson("/api/work-items/" + w.item.id + "/vendor-message", { text });
      toast.success("Recorded. The Vendor Liaison is reading it.");
      setText("");
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("space-y-2", className)}>
      {w.vendorMessages.length ? <div className="text-[12px] font-medium text-zinc-500">Replies</div> : null}
      {w.vendorMessages.map((m) => (
        <Bubble key={m.id} m={m} vendor={vendor} />
      ))}
      {canPaste ? (
        open ? (
          <form
            className="flex items-end gap-1.5 rounded-xl bg-white p-1.5 pl-3 ring-1 ring-zinc-300 focus-within:ring-zinc-500"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim().length >= 3) void send();
            }}
          >
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"Paste what " + vendor + " wrote"}
              rows={3}
              className="min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[12.5px] outline-none placeholder:text-zinc-400"
            />
            <button
              type="submit"
              disabled={text.trim().length < 3 || busy}
              aria-label="Record reply"
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-zinc-900 text-white disabled:bg-zinc-200 disabled:text-zinc-400"
            >
              {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <CornerDownLeft className="size-3.5" />}
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="text-[12px] text-zinc-500 hover:text-zinc-900">
            Vendor replied somewhere else? Paste it
          </button>
        )
      ) : null}
    </div>
  );
}
