"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, LoaderCircle, X } from "lucide-react";
import { postJson } from "@/lib/api";
import { FLOWER_COLORS, Flower, MeadowStrip } from "./landing/meadow";
import { PixelAgent } from "./pixel-agent";

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
  { title: "Start a case", body: "A Lambda bill charged 12 GPU hours after the instance was shut down." },
  { title: "Watch, then decide", body: "The team digs in on the canvas and asks you to approve a $1,200 dispute." },
  { title: "Play the vendor", body: "On the task, paste \u201cWe\u2019ve issued credit memo CM-1042 for $1,200.00\u201d and watch it close." },
];

const CREW = ["agent.capacity", "agent.compute", "agent.finance", "you", "agent.vendor", "agent.budget", "agent.policy"];

/**
 * A one-screen intro for first-time visitors (judges): a little meadow with the
 * team in it, three flower-bulleted steps, and a button that starts the sample case.
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
      <div className="animate-enter relative w-full max-w-[520px] overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-zinc-200">
        {/* a little meadow with the team in it: the only pixel art on the card */}
        <div className="relative h-[92px]">
          <MeadowStrip className="absolute inset-0 size-full" />
          <div className="absolute inset-x-0 bottom-2 flex items-end justify-center gap-2" aria-hidden>
            {CREW.map((id) => (
              <PixelAgent key={id} actorId={id} size={id === "you" ? 32 : 24} />
            ))}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="absolute top-2.5 right-2.5 grid size-7 place-items-center rounded-lg bg-white/80 text-zinc-500 backdrop-blur-sm hover:bg-white hover:text-zinc-900"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="px-7 pt-6 pb-7">
          <h1 id="onboarding-title" className="text-[24px] leading-[1.15] font-semibold tracking-[-0.02em] text-zinc-950">
            Meet your tiny finance team
          </h1>
          <p className="mt-1.5 text-[14px] leading-relaxed text-zinc-600">Six AI accountants run GPU payables for Atlas Research. You&rsquo;re the controller: you just make the calls.</p>

          <ol className="mt-5 space-y-3.5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <Flower petal={FLOWER_COLORS[(i + 1) % FLOWER_COLORS.length].petal} eye={FLOWER_COLORS[(i + 1) % FLOWER_COLORS.length].eye} size={15} className="mt-0.5 shrink-0" />
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
    </div>
  );
}
