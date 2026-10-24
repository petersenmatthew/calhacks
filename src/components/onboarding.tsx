"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, LoaderCircle, X } from "lucide-react";
import { postJson } from "@/lib/api";
import { cn } from "@/lib/utils";

const SEEN_KEY = "moa-onboarded-v1";

/** Whether this browser has already seen the intro. Storage can be blocked; then it simply shows again. */
export function hasSeenOnboarding() {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private window: fine */
  }
}

const STEPS = [
  { title: "Start a case", body: "A Lambda invoice arrives that billed 12 GPU hours after the instance was shut down." },
  { title: "Watch, then decide", body: "The agents investigate on the canvas and ask you to approve a $1,200 dispute." },
  {
    title: "Play the vendor",
    body: "On the task, paste a reply like “We’ve issued credit memo CM-1042 for $1,200.00” and watch the case close.",
  },
];

/**
 * A one-screen intro for first-time visitors (judges): what MOA is, what to
 * click, and a button that starts the sample case and opens it on the canvas.
 */
export function Onboarding({ open, publicDemo, onClose, onStarted }: { open: boolean; publicDemo: boolean; onClose: () => void; onStarted: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!open) return null;

  const close = () => {
    markSeen();
    onClose();
  };
  const start = async () => {
    setBusy(true);
    try {
      const r = await postJson<{ status: string; workItemId?: string | null }>("/api/demo/simulate", { scenario: "overbilling" });
      markSeen();
      onStarted();
      onClose();
      router.push(r.workItemId ? "/canvas?task=" + r.workItemId : "/canvas");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-zinc-900/30 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="animate-enter relative w-full max-w-[560px] rounded-2xl bg-white p-7 shadow-xl ring-1 ring-zinc-200">
        <button type="button" onClick={close} aria-label="Close" className="absolute top-4 right-4 grid size-8 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700">
          <X className="size-4" />
        </button>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-primary px-2.5 py-0.5 font-mono text-[11px] font-semibold tracking-wider text-primary-foreground uppercase">MOA</span>
          <span className="font-mono text-[11px] tracking-wider text-zinc-500 uppercase">Mixture of Accountants</span>
        </div>
        <h1 id="onboarding-title" className="mt-4 text-[26px] leading-[1.15] font-semibold tracking-[-0.02em] text-zinc-950">An AI finance team for an AI lab</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-zinc-600">
          Six AI employees run GPU payables for Atlas Research: they check every invoice line against what actually ran, dispute overcharges with the vendor, and book the result.
          You&rsquo;re the controller. You only make the calls.
        </p>

        <ol className="mt-6 space-y-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span className={cn("grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold", i === 0 ? "bg-primary text-primary-foreground" : "bg-zinc-100 text-zinc-600")}>{i + 1}</span>
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-zinc-900">{s.title}</div>
                <div className="text-[13px] leading-snug text-zinc-500">{s.body}</div>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-7 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={start}
            disabled={busy}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-zinc-900 px-4 text-[14px] font-medium text-white hover:bg-zinc-800 disabled:opacity-60"
          >
            {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Start the sample case
            {!busy ? <ArrowRight className="size-4" /> : null}
          </button>
          <button type="button" onClick={close} className="h-10 rounded-lg px-3 text-[14px] text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">
            Look around first
          </button>
        </div>

        {publicDemo ? (
          <p className="mt-5 border-t border-zinc-100 pt-4 text-[12px] leading-snug text-zinc-500">
            Shared demo: other people may be using it at the same time. Slack and email are recorded on each task here, not sent. <b className="font-medium text-zinc-700">Reset demo</b> starts everything over.
          </p>
        ) : null}
      </div>
    </div>
  );
}
