"use client";

import { MeadowStrip } from "./landing/meadow";
import { PixelAgent } from "./pixel-agent";
import { cn } from "@/lib/utils";

export const CREW = ["agent.capacity", "agent.compute", "agent.finance", "you", "agent.vendor", "agent.budget", "agent.policy"];

/** The intro card's header: a strip of meadow with the team standing in it. The core brand moment. */
export function CrewMeadow({ seed = 3, height = 92, crew = CREW, size = 24, className, children }: { seed?: number; height?: number; crew?: string[]; size?: number; className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("relative shrink-0 overflow-hidden", className)} style={{ height }}>
      <MeadowStrip seed={seed} className="absolute inset-0 size-full" />
      <div className="absolute inset-x-0 bottom-2 flex items-end justify-center gap-2" aria-hidden>
        {crew.map((id) => (
          <PixelAgent key={id} actorId={id} size={id === "you" ? Math.round(size * 1.33) : size} />
        ))}
      </div>
      {children}
    </div>
  );
}
