"use client";

import { hours } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { WorkspaceData } from "@/server/queries";
import { PROJECT_COLORS } from "./workspace-context";

export function ReservationUsage({ data }: { data: WorkspaceData }) {
  const u = data.reservationUsage;
  const r = data.reservation;
  if (!u || !r) return null;
  const total = u.reservedGpuHours || 1;
  const segments = [
    ...u.usageByProject.map((p) => ({
      key: p.projectId,
      label: data.projects[p.projectId]?.name ?? p.projectId,
      gpuHours: p.gpuHours,
      className: PROJECT_COLORS[p.projectId]?.bar ?? "bg-zinc-500",
      owner: p.projectId === r.ownerProjectId,
    })),
    { key: "idle", label: "Idle reserved capacity", gpuHours: u.idleGpuHours, className: "hatch-zinc", owner: false },
  ];
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="mb-2 flex items-center justify-between text-[11.5px]">
        <span className="font-medium text-zinc-700">Reserved capacity consumption</span>
        <span className="text-muted-foreground tnum">{u.reservedGpuHours.toLocaleString("en-US")} GPU-h reserved</span>
      </div>
      <div className="flex h-6 overflow-hidden rounded-md ring-1 ring-zinc-200">
        {segments.map((s) => (
          <div
            key={s.key}
            className={cn("flex items-center justify-center text-[10px] font-semibold text-white", s.className)}
            style={{ width: (s.gpuHours / total) * 100 + "%" }}
            title={s.label + ": " + s.gpuHours + " GPU-h"}
          >
            <span className={cn(s.key === "idle" && "text-zinc-600")}>{Math.round((s.gpuHours / total) * 100)}%</span>
          </div>
        ))}
      </div>
      <div className="mt-2.5 space-y-1">
        {segments.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-[11.5px]">
            <span className={cn("size-2.5 rounded-sm", s.className)} />
            <span className="flex-1 truncate text-zinc-700">
              {s.label}
              {s.owner ? <span className="ml-1.5 rounded bg-zinc-100 px-1 py-px text-[10px] font-medium text-zinc-600">reservation owner</span> : null}
            </span>
            <span className="text-muted-foreground tnum">{hours(s.gpuHours).replace(" h", " GPU-h")}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
