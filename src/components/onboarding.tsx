"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X } from "lucide-react";
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#1f3a17]/35 p-4" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap" />
      <div className="animate-enter relative w-full max-w-[500px] overflow-hidden border-[3px] border-[#2a2420] bg-[#fffaf0] shadow-[0_6px_0_#2a2420]">
        <div className="relative h-[104px]">
          <MeadowStrip className="absolute inset-0 size-full" />
          <div className="absolute inset-x-0 bottom-2 flex items-end justify-center gap-2" aria-hidden>
            {CREW.map((id) => (
              <PixelAgent key={id} actorId={id} size={id === "you" ? 34 : 26} />
            ))}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="absolute top-2 right-2 grid size-7 place-items-center border-2 border-[#2a2420] bg-[#fffaf0] text-[#2a2420] hover:bg-white"
          >
            <X className="size-3.5" strokeWidth={3} />
          </button>
        </div>

        <div className="border-t-[3px] border-[#2a2420] px-6 pt-5 pb-6">
          <h1 id="onboarding-title" className="text-[30px] leading-[1.1] font-semibold text-[#2a2420]" style={{ fontFamily: "'Fraunces', Georgia, serif" }}>
            Meet your tiny finance team
          </h1>
          <p className="mt-1.5 text-[14px] leading-relaxed text-[#5b524a]">Six AI accountants run GPU payables for Atlas Research. You&rsquo;re the controller: you just make the calls.</p>

          <ol className="mt-5 space-y-3.5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <Flower petal={FLOWER_COLORS[(i + 1) % FLOWER_COLORS.length].petal} eye={FLOWER_COLORS[(i + 1) % FLOWER_COLORS.length].eye} size={18} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold text-[#2a2420]">{s.title}</div>
                  <div className="text-[13px] leading-snug text-[#5b524a]">{s.body}</div>
                </div>
              </li>
            ))}
          </ol>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={start}
              disabled={busy}
              className="border-[3px] border-[#2a2420] bg-[#c6d600] px-5 py-2 font-mono text-[14px] font-bold tracking-[0.12em] text-[#2a2420] uppercase shadow-[0_4px_0_#2a2420] transition-transform hover:-translate-y-0.5 hover:shadow-[0_6px_0_#2a2420] active:translate-y-1 active:shadow-[0_1px_0_#2a2420] disabled:opacity-70"
            >
              {busy ? "Starting\u2026" : "Start \u25B8"}
            </button>
            <button type="button" onClick={close} className="px-2 py-2 font-mono text-[13px] font-semibold tracking-wider text-[#5b524a] uppercase hover:text-[#2a2420]">
              Look around
            </button>
          </div>

          {publicDemo ? (
            <p className="mt-5 border-t-2 border-dashed border-[#d9d0bf] pt-3 text-[12px] leading-snug text-[#7a7064]">
              Shared demo: others may be playing at the same time. Slack and email are recorded here, not sent. Reset demo starts everything over.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
