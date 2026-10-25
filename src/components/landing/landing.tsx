"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MeadowScene, Roamers } from "./scene";

/*
 * The front door: a pixel meadow, a title, one line, one button.
 */

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
    <div className="relative h-dvh overflow-hidden bg-[#45b4ee]">
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap" />
      <MeadowScene />
      <Roamers />

      <main className="pointer-events-none absolute inset-x-0 top-0 z-[200] flex h-[62%] flex-col items-center justify-center px-6 text-center">
        <h1 className="text-[96px] leading-none font-semibold tracking-[-0.02em] text-white sm:text-[160px]" style={{ fontFamily: "'Fraunces', Georgia, serif" }}>
          moa
        </h1>
        <p className="mt-3 max-w-[440px] text-[17px] leading-relaxed font-medium text-white sm:text-[20px]">Autonomous finance for AI research labs</p>
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="pointer-events-auto mt-8 rounded-xl bg-white px-7 py-3 text-[15px] font-semibold text-[#1f3b5a] shadow-[0_4px_0_rgb(31_59_90/0.18)] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 disabled:opacity-70"
        >
          {busy ? "Starting\u2026" : "Start \u2192"}
        </button>
      </main>
    </div>
  );
}
