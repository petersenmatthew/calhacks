"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MeadowScene, Roamers } from "./scene";

/*
 * The front door: a pixel meadow, a title, and links to the demo video and the repo.
 * Hovering "Watch the demo" peeks a thumbnail; clicking opens the video over the meadow.
 */

const REPO_URL = "https://github.com/petersenmatthew/moa";
const YOUTUBE_ID = "K_pESfSqoDQ";
const YOUTUBE_SRC = `https://www.youtube-nocookie.com/embed/${YOUTUBE_ID}?autoplay=1&controls=0&rel=0&playsinline=1&iv_load_policy=3&disablekb=1&cc_load_policy=0&enablejsapi=1`;

/*
 * The YouTube player with its own controls hidden, driven over postMessage, so the
 * controls below the video match the page.
 */
function DemoPlayer() {
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [dragging, setDragging] = useState(false);
  // Hide the player until it starts playing, so the poster shows instead of YouTube's black loading box.
  const [started, setStarted] = useState(false);

  const send = useCallback((func: string, args: unknown[] = []) => {
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || typeof e.data !== "string") return;
      let msg: { event?: string; info?: { currentTime?: number; duration?: number; playerState?: number } };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      const info = msg.info;
      if (!info) return;
      if (typeof info.duration === "number" && info.duration > 0) setDuration(info.duration);
      if (typeof info.currentTime === "number" && !dragging) setTime(info.currentTime);
      // 1 = playing, 2 = paused, 0 = ended.
      if (info.playerState === 1) {
        setPlaying(true);
        setStarted(true);
      }
      if (info.playerState === 2 || info.playerState === 0) setPlaying(false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [dragging]);

  const onLoad = () => {
    // If autoplay is blocked the player never reports playing; show it anyway.
    setTimeout(() => setStarted(true), 2500);
    // Subscribe to time updates. The video has captions burned in, so turn off
    // YouTube's own (it auto-enables them when muted). The player ignores messages
    // until it is ready, so repeat for the first few seconds.
    [300, 1000, 2000, 3500, 5000].forEach((ms) =>
      setTimeout(() => {
        frame.current?.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1 }), "*");
        send("unloadModule", ["captions"]);
      }, ms),
    );
  };

  const toggle = () => {
    send(playing ? "pauseVideo" : "playVideo");
    setPlaying(!playing);
  };

  const seek = (t: number) => {
    setTime(t);
    send("seekTo", [t, true]);
  };

  // Fullscreen the whole player, controls included. iPhone Safari only allows fullscreen for native
  // video, so there the button opens the video on YouTube at the current time instead.
  useEffect(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element };
    const onChange = () => setFull(Boolean(doc.fullscreenElement || doc.webkitFullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  const toggleFull = () => {
    const doc = document as Document & { webkitFullscreenEnabled?: boolean; webkitExitFullscreen?: () => void };
    if (full) {
      if (document.exitFullscreen) document.exitFullscreen();
      else doc.webkitExitFullscreen?.();
      return;
    }
    const el = box.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    if (el && (document.fullscreenEnabled || doc.webkitFullscreenEnabled)) {
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      else el.webkitRequestFullscreen?.();
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      orientation?.lock?.("landscape").catch(() => {});
      return;
    }
    send("pauseVideo");
    setPlaying(false);
    window.open(`https://www.youtube.com/watch?v=${YOUTUBE_ID}&t=${Math.floor(time)}s`, "_blank", "noopener");
  };

  const pct = duration ? (time / duration) * 100 : 0;

  return (
    <div ref={box} className={full ? "flex h-full w-full flex-col bg-black" : undefined}>
      <div className={(full ? "min-h-0 flex-1" : "aspect-video") + " w-full bg-cover bg-top"} style={{ backgroundImage: "url(/landing/poster.png)" }}>
        <iframe
          ref={frame}
          src={YOUTUBE_SRC}
          title="moa demo"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          className={`h-full w-full transition-opacity duration-500 ${started ? "opacity-100" : "opacity-0"}`}
          onLoad={onLoad}
        />
      </div>
      <div className="flex items-center gap-3 bg-white px-4 py-2.5 text-[#1f3b5a]">
        <button type="button" onClick={toggle} aria-label={playing ? "Pause" : "Play"} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-[#1f3b5a]/10">
          {playing ? (
            <span className="flex gap-[3px]">
              <span className="h-3.5 w-[4px] rounded-sm bg-current" />
              <span className="h-3.5 w-[4px] rounded-sm bg-current" />
            </span>
          ) : (
            <span className="ml-0.5 h-0 w-0 border-y-[7px] border-l-[11px] border-y-transparent border-l-current" />
          )}
        </button>
        <span className="w-[86px] shrink-0 text-[13px] font-semibold tabular-nums">
          {clock(time)} / {clock(duration)}
        </span>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={time}
          aria-label="Seek"
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onChange={(e) => seek(Number(e.target.value))}
          className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full accent-[#1f3b5a] [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#1f3b5a]"
          style={{ background: `linear-gradient(to right, #1f3b5a ${pct}%, #1f3b5a26 ${pct}%)` }}
        />
        <button
          type="button"
          onClick={toggleFull}
          aria-label={full ? "Exit full screen" : "Full screen"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-[#1f3b5a]/10"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {full ? <path d="M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4" /> : <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />}
          </svg>
        </button>
      </div>
    </div>
  );
}

function clock(s: number) {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

export function Landing() {
  const [open, setOpen] = useState(false);
  // `open` mounts the popup; `shown` drives its fade and rise, a frame later on open and before unmount on close.
  const [shown, setShown] = useState(false);
  const openVideo = () => {
    setOpen(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
  };
  const closeVideo = () => {
    setShown(false);
    setTimeout(() => setOpen(false), 250);
  };

  return (
    <div className="relative h-dvh overflow-hidden bg-[#45b4ee]">
      <MeadowScene />
      <Roamers />
      <Link href="/about" className="absolute top-5 right-6 z-[250] text-[15px] font-semibold text-white/90 hover:text-white">
        About
      </Link>

      <main className="pointer-events-none absolute inset-x-0 top-0 z-[200] flex h-[62%] flex-col items-center justify-center px-6 text-center">
        <h1 className="text-[96px] leading-none font-semibold tracking-[-0.05em] text-white sm:text-[160px]">
          moa
        </h1>
        <p className="mt-3 max-w-[440px] text-[17px] leading-relaxed font-medium text-white sm:text-[20px]">Autonomous finance for AI research labs</p>

        <div className="pointer-events-auto mt-8 flex gap-3">
          <div className="group relative">
            <button
              type="button"
              onClick={openVideo}
              className="flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-[15px] font-semibold text-[#1f3b5a] shadow-[0_4px_0_rgb(31_59_90/0.18)] transition-transform hover:-translate-y-0.5"
            >
              <span className="h-0 w-0 border-y-[6px] border-l-[9px] border-y-transparent border-l-current" />
              Watch the demo
            </button>
            {/* The top padding bridges the gap, so moving down from the button keeps the preview open. */}
            <div className="invisible absolute top-full left-1/2 w-[300px] -translate-x-1/2 translate-y-1 pt-4 opacity-0 transition-all duration-200 group-hover:visible group-hover:translate-y-0 group-hover:opacity-100">
              <button
                type="button"
                onClick={openVideo}
                aria-label="Play the demo"
                className="relative block w-full overflow-hidden rounded-xl border-[3px] border-white bg-black shadow-[0_6px_0_rgb(31_59_90/0.2)]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/landing/poster.png" alt="" className="aspect-video w-full object-cover object-top" />
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/95 shadow">
                    <span className="ml-1 h-0 w-0 border-y-[8px] border-l-[12px] border-y-transparent border-l-[#1f3b5a]" />
                  </span>
                </span>
                <span className="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-white">3:10</span>
              </button>
            </div>
          </div>
          <a
            href={REPO_URL}
            className="flex items-center gap-2 rounded-xl bg-[#1f3b5a] px-6 py-3 text-[15px] font-semibold text-white shadow-[0_4px_0_rgb(0_0_0/0.18)] transition-transform hover:-translate-y-0.5"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4 fill-current" aria-hidden>
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            GitHub
          </a>
        </div>
      </main>

      {open && (
        <div
          className={`absolute inset-0 z-[300] flex items-center justify-center p-6 transition-all duration-300 ease-out ${shown ? "bg-[#1f3b5a]/60 backdrop-blur-sm" : "bg-[#1f3b5a]/0 backdrop-blur-none"}`}
          onClick={closeVideo}
        >
          <div
            className={`w-[min(960px,92vw)] overflow-hidden rounded-2xl border-4 border-white bg-black shadow-2xl transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${shown ? "translate-y-0 scale-100 opacity-100" : "translate-y-4 scale-[0.96] opacity-0"}`}
            onClick={(e) => e.stopPropagation()}
          >
            <DemoPlayer />
          </div>
        </div>
      )}
    </div>
  );
}
