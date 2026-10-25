"use client";

import { useRouter } from "next/navigation";
import { MeadowScene, Roamers } from "./scene";

/*
 * The front door: a pixel meadow, a title, one line, one button.
 */

export function Landing() {
  const router = useRouter();
  // Start goes to the app with the intro open; the sample case starts from there.
  const start = () => router.push("/canvas?intro=1");

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
          className="pointer-events-auto mt-8 rounded-xl bg-white px-7 py-3 text-[15px] font-semibold text-[#1f3b5a] shadow-[0_4px_0_rgb(31_59_90/0.18)] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 disabled:opacity-70"
        >
          Start {"\u2192"}
        </button>
      </main>
    </div>
  );
}
