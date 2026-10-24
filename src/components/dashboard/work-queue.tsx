"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useNow } from "@/lib/use-now";
import { money, periodLabel, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardData } from "@/server/queries";
import { AgentAvatar, PriorityIcon, StateBadge } from "../status";

type Filter = "open" | "approval" | "all";

const TYPE_LABEL: Record<string, string> = { BILLING_VARIANCE: "Billing variance", SHARED_ALLOCATION: "Shared allocation" };

export function WorkQueue({ data, fresh }: { data: DashboardData; fresh: Set<string> }) {
  const router = useRouter();
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const open = data.workItems.filter((i) => i.state !== "RESOLVED");
  const approval = data.workItems.filter((i) => i.state === "NEEDS_APPROVAL" || i.pendingApproval);
  const rows = filter === "open" ? open : filter === "approval" ? approval : data.workItems;
  const tabs: { key: Filter; label: string; count: number }[] = [
    { key: "open", label: "Open", count: open.length },
    { key: "approval", label: "Needs approval", count: approval.length },
    { key: "all", label: "All", count: data.workItems.length },
  ];

  return (
    <div className="min-w-0 rounded-xl bg-white ring-1 ring-zinc-200/80">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <div className="text-[13px] font-semibold">Work queue</div>
          <div className="text-[11.5px] text-muted-foreground">Exceptions opened by deterministic checks and worked by agents</div>
        </div>
        <div className="flex rounded-lg bg-zinc-100 p-0.5">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setFilter(t.key)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                filter === t.key ? "bg-white text-zinc-900 shadow-xs" : "text-zinc-500 hover:text-zinc-800",
              )}
            >
              {t.label} <span className="ml-0.5 text-zinc-400 tnum">{t.count}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] table-fixed text-[12.5px]">
          <colgroup>
            <col className="w-[76px]" />
            <col />
            <col className="w-[112px]" />
            <col className="w-[118px]" />
            <col className="w-[34%]" />
            <col className="w-[44px]" />
          </colgroup>
          <thead>
            <tr className="border-b text-left text-[11px] font-medium text-muted-foreground">
              <th className="py-2 pr-2 pl-4 font-medium">ID</th>
              <th className="px-2 py-2 font-medium">Investigation</th>
              <th className="px-2 py-2 text-right font-medium">Amount</th>
              <th className="px-2 py-2 font-medium">State</th>
              <th className="px-2 py-2 font-medium">Agent and latest action</th>
              <th className="py-2 pr-4 pl-2 text-center font-medium">Pri</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-[12.5px] text-muted-foreground">
                  {filter === "open" ? "No open investigations. Simulate a billing event to give the team work." : "Nothing here."}
                </td>
              </tr>
            ) : null}
            {rows.map((row) => {
              const agentName = row.assignedAgentId ? data.actors[row.assignedAgentId]?.name : null;
              return (
                <tr
                  key={row.id + ":" + row.updatedAt}
                  onClick={() => router.push("/investigations/" + row.id)}
                  className={cn("cursor-pointer border-b last:border-0 hover:bg-zinc-50", fresh.has(row.id) && "animate-flash")}
                >
                  <td className="py-2.5 pr-2 pl-4 align-top font-mono text-[11.5px] text-muted-foreground">{row.id}</td>
                  <td className="px-2 py-2.5 align-top">
                    <div className="truncate font-medium text-zinc-900">{row.title}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                      <span>{TYPE_LABEL[row.type] ?? row.type}</span>
                      <span>·</span>
                      <span className="font-mono">{row.resource}</span>
                      <span>·</span>
                      <span>{data.providers[row.providerId]?.shortName}</span>
                      {row.period !== data.period ? <span>· {periodLabel(row.period, true)}</span> : null}
                    </div>
                  </td>
                  <td className="px-2 py-2.5 text-right align-top tnum">
                    <div className="font-medium text-zinc-900">{money(row.amountCents)}</div>
                    {row.type === "BILLING_VARIANCE" && Math.abs(row.discrepancyCents) >= 100 ? (
                      <div className="text-[11px] font-medium text-rose-600">{money(row.discrepancyCents, { sign: true })} variance</div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2.5 align-top">
                    <StateBadge state={row.state} />
                  </td>
                  <td className="px-2 py-2.5 align-top">
                    <div className="flex items-start gap-2">
                      {agentName && row.state !== "RESOLVED" ? (
                        <AgentAvatar actorId={row.assignedAgentId!} size="sm" className="mt-px" />
                      ) : null}
                      <div className="min-w-0">
                        <div className="truncate text-zinc-700">{row.latestAction}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {agentName && row.state !== "RESOLVED" ? agentName + " · " : ""}
                          {relativeTime(row.updatedAt, now)}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 pr-4 pl-2 text-center align-top">
                    <PriorityIcon priority={row.priority} className="inline-block" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
