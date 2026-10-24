"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PixelAgent } from "../pixel-agent";
import { Field } from "./meadow";

/*
 * The front door: a pixel meadow, a title, one line, one button.
 */

/** The team out in the field; "you" stands in the middle. */
const CREW = ["agent.capacity", "agent.compute", "agent.finance", "you", "agent.vendor", "agent.budget", "agent.policy"];

export function Landing() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/demo/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: "overbilling" }) });
      const body = (await r.json().catch(() => ({}))) as { workItemId?: string | null; error?: string };
      if (!r.ok) throw new Error(body.error ?? "Could not start");
      try {
        window.localStorage.setItem("moa-onboarded-v1", "1");
      } catch {
        /* fine */
      }
      router.push(body.workItemId ? "/canvas?task=" + body.workItemId : "/canvas");
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="relative h-dvh overflow-hidden bg-[#62b34c]">
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap" />
      <Field />

      <main className="relative z-10 flex h-full flex-col items-center justify-center px-6 pb-[16vh] text-center">
        <h1
          className="text-[52px] leading-[1.02] font-semibold tracking-[-0.01em] text-[#fffaf0] sm:text-[88px]"
          style={{ fontFamily: "'Fraunces', Georgia, serif", textShadow: "0 3px 0 rgb(35 80 25 / 0.35)" }}
        >
          Mixture of
          <br />
          Accountants
        </h1>
        <p className="mt-5 max-w-[460px] text-[16px] leading-relaxed font-medium text-[#fffaf0] sm:text-[18px]" style={{ textShadow: "0 1px 0 rgb(35 80 25 / 0.45)" }}>
          Six tiny AI accountants catch your GPU overbilling, chase the vendor, and get your money back. You just make the calls.
        </p>
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="mt-9 border-[3px] border-[#2a2420] bg-[#fffaf0] px-8 py-3 font-mono text-[16px] font-bold tracking-[0.12em] text-[#2a2420] uppercase shadow-[0_5px_0_#2a2420] transition-transform hover:-translate-y-0.5 hover:shadow-[0_7px_0_#2a2420] active:translate-y-1 active:shadow-[0_1px_0_#2a2420] disabled:opacity-70"
        >
          {busy ? "Starting…" : "Start ▸"}
        </button>
      </main>

      {/* the crew, standing in the grass */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[6vh] z-10 flex items-end justify-center gap-3 sm:gap-6" aria-hidden>
        {CREW.map((id) => (
          <PixelAgent key={id} actorId={id} size={id === "you" ? 64 : 48} className={id === "you" ? "h-auto w-[44px] sm:w-[64px]" : "h-auto w-[34px] sm:w-[48px]"} />
        ))}
      </div>
    </div>
  );
}
