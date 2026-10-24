"use client";

import { money } from "@/lib/format";
import type { Proof, Segment } from "@/lib/decision";
import { cn } from "@/lib/utils";

export const TONE_BG: Record<Segment["tone"], string> = {
  a: "bg-primary",
  b: "bg-zinc-800",
  c: "bg-zinc-400",
  d: "bg-zinc-200",
  idle: "hatch-zinc",
};

function fmt(unit: "h" | "$" | "$/h", v: number) {
  if (unit === "h") return (Math.round(v * 10) / 10).toLocaleString("en-US") + " h";
  if (unit === "$/h") return money(v, { cents: v % 100 !== 0 }) + "/h";
  return money(v, { cents: v % 100 !== 0 });
}

/**
 * Billed against owed on one scale. The part billed beyond what is owed is hatched,
 * so the problem is visible before any text is read.
 */
function Compare({ proof, size }: { proof: Extract<Proof, { kind: "compare" }>; size: "sm" | "lg" }) {
  const { billed, owed, marker, unit } = proof;
  const max = Math.max(billed.value, owed.value, marker?.value ?? 0) || 1;
  // The longest bar stops short of the edge so its value label always fits.
  const SCALE = 0.8;
  const pct = (v: number) => (v / max) * SCALE * 100 + "%";
  const over = billed.value > owed.value;
  const bar = size === "lg" ? "h-9" : "h-6";
  const rows = [
    { key: "billed", label: billed.label, value: billed.value },
    { key: "owed", label: owed.label, value: owed.value },
  ];
  return (
    <div className="relative">
      <div className={cn("grid items-center gap-x-3", size === "lg" ? "grid-cols-[72px_1fr] gap-y-2.5" : "grid-cols-[56px_1fr] gap-y-1.5")}>
        {rows.map((r) => (
          <div key={r.key} className="contents">
            <span className={cn("text-zinc-500", size === "lg" ? "text-[13px]" : "text-[12px]")}>{r.label}</span>
            <div className={cn("relative rounded-md bg-zinc-100/70", bar)}>
              {r.key === "billed" ? (
                <>
                  <div className={cn("absolute inset-y-0 left-0 rounded-l-md bg-zinc-800", !over && "rounded-r-md")} style={{ width: pct(Math.min(billed.value, owed.value)) }} />
                  {over ? (
                    <div
                      className="hatch-red absolute inset-y-0 rounded-r-md ring-1 ring-destructive/25 ring-inset"
                      style={{ left: pct(owed.value), width: pct(billed.value - owed.value) }}
                    />
                  ) : null}
                </>
              ) : (
                <div className="absolute inset-y-0 left-0 rounded-md bg-primary" style={{ width: pct(r.value) }} />
              )}
              <span
                className={cn(
                  "absolute top-1/2 -translate-y-1/2 pl-2 font-medium whitespace-nowrap text-zinc-700 tnum",
                  size === "lg" ? "text-[13px]" : "text-[11.5px]",
                )}
                style={{ left: pct(r.value) }}
              >
                {fmt(unit, r.value)}
              </span>
            </div>
          </div>
        ))}
      </div>
      {marker ? (
        <div
          className={cn("pointer-events-none absolute -top-1 -bottom-1 border-l border-dashed border-zinc-400", size === "lg" ? "ml-[84px]" : "ml-[68px]")}
          style={{ left: "calc((100% - " + (size === "lg" ? 84 : 68) + "px) * " + (marker.value / max) * SCALE + ")" }}
        >
          <span className="absolute -top-4 -translate-x-1/2 text-[10px] whitespace-nowrap text-zinc-500 tnum">
            {marker.label} {money(marker.value, { cents: false })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function SplitBar({ segments, className }: { segments: Segment[]; className?: string }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <div className={cn("flex h-2 gap-px overflow-hidden rounded-full", className)}>
      {segments.map((s) => (
        <div key={s.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", TONE_BG[s.tone])} style={{ width: (s.value / total) * 100 + "%" }} />
      ))}
    </div>
  );
}

function Usage({ proof, size }: { proof: Extract<Proof, { kind: "usage" }>; size: "sm" | "lg" }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-[12px] text-zinc-500">
        <span>Hours used</span>
        <span className="tnum">{proof.reserved.toLocaleString("en-US")} reserved</span>
      </div>
      <SplitBar segments={proof.segments} className={size === "lg" ? "h-3" : "h-2"} />
      <div className={cn("mt-2.5 flex flex-wrap gap-x-4 gap-y-1", size === "lg" ? "text-[13px]" : "text-[12px]")}>
        {proof.segments.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-zinc-600">
            <span className={cn("size-2 rounded-full", TONE_BG[s.tone])} />
            {s.label}
            {s.key === proof.ownerKey ? <span className="text-zinc-400">(reserved it)</span> : null}
            <span className="text-zinc-400 tnum">{s.value.toLocaleString("en-US")} h</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function ProofView({ proof, size = "sm" }: { proof: Proof; size?: "sm" | "lg" }) {
  return proof.kind === "compare" ? <Compare proof={proof} size={size} /> : <Usage proof={proof} size={size} />;
}

