"use client";

import Link from "next/link";
import { Check, Layers, LoaderCircle, Receipt } from "lucide-react";
import { agentSteps, AGENT_SHORT, BOARD_STAGES, boardStage, type BoardStage } from "@/lib/agent-steps";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardData } from "@/server/queries";
import { StepList } from "../agent-steps";
import { AgentAvatar } from "../status";

type Item = DashboardData["workItems"][number];
type Agent = DashboardData["agents"][number];

const DONE_LIMIT = 6;

function Tag({ stage, item, agent }: { stage: BoardStage; item: Item; agent?: Agent }) {
  const base = "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-medium";
  if (agent?.status === "working") {
    return (
      <span className={cn(base, "bg-blue-50 text-blue-700")}>
        <LoaderCircle className="size-3 animate-spin" />
        {AGENT_SHORT[agent.agentId]}
      </span>
    );
  }
  if (agent?.status === "queued") return <span className={cn(base, "bg-amber-50 text-amber-700")}>Queued</span>;
  if (stage === "needs_you") return <span className={cn(base, "bg-orange-50 text-orange-700")}>Your turn</span>;
  if (stage === "vendor") return <span className={cn(base, "bg-rose-50 text-rose-700")}>Disputed</span>;
  if (stage === "done") return <Check className="size-4 shrink-0 rounded-full bg-emerald-500 p-0.5 text-white" />;
  return item.state === "NEW" ? <span className={cn(base, "bg-zinc-100 text-zinc-600")}>New</span> : null;
}

function Card({ item, stage, data, agent }: { item: Item; stage: BoardStage; data: DashboardData; agent?: Agent }) {
  const Icon = item.type === "BILLING_VARIANCE" ? Receipt : Layers;
  const working = agent?.status === "working";
  const variance = item.type === "BILLING_VARIANCE" && item.discrepancyCents >= 100 ? item.discrepancyCents : 0;
  const steps = working ? agentSteps(agent.agentId, agent.runTools, "running").steps : null;
  return (
    <Link
      href={"/investigations/" + item.id}
      className={cn("card-soft block p-3 transition-transform hover:-translate-y-px animate-enter", working && "outline-2! outline-blue-300!", stage === "done" && "opacity-60 hover:opacity-100")}
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-zinc-50 ring-1 ring-zinc-200">
          <Icon className="size-4 text-zinc-600" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-zinc-900">
            {data.providers[item.providerId]?.shortName} · {item.resource}
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="text-[11.5px] text-muted-foreground tnum">
              {money(item.amountCents, { cents: false })}
              {variance ? <span className="text-rose-600"> {money(variance, { sign: true, cents: false })}</span> : null}
            </span>
            <Tag stage={stage} item={item} agent={agent} />
          </div>
        </div>
      </div>
      {steps ? (
        <div className="mt-3 rounded-lg bg-zinc-50 px-3 py-2.5 ring-1 ring-zinc-200/70">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-700">
            <AgentAvatar actorId={agent!.agentId} size="sm" className="size-4" />
            {data.actors[agent!.agentId]?.name}
          </div>
          <StepList steps={steps} />
        </div>
      ) : null}
    </Link>
  );
}

export function Board({ data }: { data: DashboardData }) {
  const agentFor = (id: string) => data.agents.find((a) => a.currentWorkItemId === id && a.status !== "idle");
  return (
    <div className="bg-dots h-full overflow-auto">
      <div className="flex h-full min-w-max px-2 py-4">
        {BOARD_STAGES.map(({ key, label }) => {
          const items = data.workItems.filter((i) => boardStage(i) === key);
          const shown = key === "done" ? items.slice(0, DONE_LIMIT) : items;
          return (
            <div key={key} className="flex w-[208px] flex-1 flex-col border-r border-dashed border-zinc-200 px-2.5 last:border-r-0">
              <div className="mb-3 flex h-6 items-center justify-between">
                <span
                  className={cn(
                    "rounded-md bg-white px-2 py-0.5 font-mono text-[10.5px] tracking-wider uppercase ring-1",
                    key === "needs_you" && items.length ? "text-orange-600 ring-orange-200" : "text-zinc-500 ring-zinc-200",
                  )}
                >
                  {label}
                </span>
                <span className="font-mono text-[11px] text-zinc-400 tnum">{items.length}</span>
              </div>
              <div className="space-y-2.5">
                {shown.map((item) => (
                  <Card key={item.id} item={item} stage={key} data={data} agent={agentFor(item.id)} />
                ))}
                {items.length > shown.length ? <div className="px-1 text-[11.5px] text-zinc-400">+{items.length - shown.length} more</div> : null}
                {items.length === 0 ? <div className="h-16 rounded-xl border border-dashed border-zinc-200" /> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
