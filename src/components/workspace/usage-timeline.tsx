"use client";

import { hours } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InstanceChecks } from "@/server/db/schema";
import type { WorkspaceData } from "@/server/queries";

function h(from: string, to: string) {
  return (Date.parse(to) - Date.parse(from)) / 3_600_000;
}

/** Visual comparison of what was billed against what actually ran. */
export function UsageTimeline({ data }: { data: WorkspaceData }) {
  const checks = data.item.checks as InstanceChecks;
  const start = checks.provisionedAt;
  if (!start) return null;
  const termH = checks.terminatedAt ? h(start, checks.terminatedAt) : checks.lifecycleHours;
  const meterStart = data.usage[0]?.usageStart ?? start;
  const meterEnd = data.usage[data.usage.length - 1]?.usageEnd ?? start;
  const meterFrom = h(start, meterStart);
  const meterTo = h(start, meterEnd);
  const span = Math.max(checks.billedHours, meterTo, termH, checks.billableHours) * 1.04;
  const pctOf = (v: number) => Math.max(0, Math.min(100, (v / span) * 100)) + "%";
  const step = span > 60 ? 24 : span > 30 ? 12 : span > 12 ? 6 : 2;
  const ticks: number[] = [];
  for (let t = 0; t <= span; t += step) ticks.push(t);

  const rows: { label: string; segments: { from: number; to: number; className: string; text?: string }[] }[] = [
    {
      label: "Invoice",
      segments: [
        { from: 0, to: Math.min(checks.billedHours, checks.billableHours), className: "bg-zinc-700", text: hours(Math.min(checks.billedHours, checks.billableHours)) },
        ...(checks.billedHours > checks.billableHours
          ? [{ from: checks.billableHours, to: checks.billedHours, className: "hatch-red ring-1 ring-rose-400 ring-inset", text: "+" + hours(checks.billedHours - checks.billableHours) }]
          : []),
      ],
    },
    {
      label: "Provider meter",
      segments: [
        { from: meterFrom, to: Math.min(meterTo, termH), className: "bg-zinc-400" },
        ...(meterTo > termH + 0.01 ? [{ from: termH, to: meterTo, className: "hatch-red ring-1 ring-rose-400 ring-inset" }] : []),
      ],
    },
    {
      label: "Instance lifecycle",
      segments: [{ from: 0, to: termH, className: "bg-teal-500", text: hours(checks.lifecycleHours) }],
    },
    {
      label: "Training job",
      segments: data.jobs.map((j) => ({ from: h(start, j.startedAt), to: h(start, j.endedAt), className: "bg-sky-500", text: hours(h(j.startedAt, j.endedAt)) })),
    },
  ];

  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="mb-2 flex items-center justify-between text-[11.5px]">
        <span className="font-medium text-zinc-700">What ran vs what was billed</span>
        <span className="text-muted-foreground">hours from provisioning</span>
      </div>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2">
            <div className="w-[92px] shrink-0 text-[11px] text-muted-foreground">{row.label}</div>
            <div className="relative h-5 flex-1 rounded bg-zinc-50">
              {row.segments.map((s, i) => (
                <div
                  key={i}
                  className={cn("absolute inset-y-0 flex items-center justify-center overflow-hidden rounded-[3px] text-[10px] font-medium text-white", s.className)}
                  style={{ left: pctOf(s.from), width: "calc(" + pctOf(s.to - s.from) + " - 1px)" }}
                >
                  {s.text ? <span className={cn("truncate px-1", s.className.includes("hatch") && "text-rose-700")}>{s.text}</span> : null}
                </div>
              ))}
              <div className="absolute inset-y-[-3px] border-l border-dashed border-rose-400" style={{ left: pctOf(termH) }} />
            </div>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <div className="w-[92px] shrink-0" />
          <div className="relative h-4 flex-1 text-[10px] text-muted-foreground">
            {ticks.map((t) => (
              <span key={t} className="absolute -translate-x-1/2 tnum" style={{ left: pctOf(t) }}>
                {t}h
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-3 rounded-sm border-l border-dashed border-rose-400" /> TERMINATED event
        </span>
        <span className="flex items-center gap-1">
          <span className="hatch-red h-2.5 w-3 rounded-sm" /> billed or metered after termination
        </span>
      </div>
    </div>
  );
}
