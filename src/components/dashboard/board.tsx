"use client";

import Link from "next/link";
import { Check, Layers, LoaderCircle, Receipt, ScrollText } from "lucide-react";
import { agentSteps, AGENT_SHORT, BOARD_STAGES, boardStage, type BoardStage } from "@/lib/agent-steps";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardData } from "@/server/queries";
import { StepList } from "../agent-steps";
import { Flower, UI_FLOWERS } from "../landing/meadow";
import { AgentAvatar } from "../status";

type Item = DashboardData["workItems"][number];
type Agent = DashboardData["agents"][number];

const DONE_LIMIT = 6;

/** Each column gets its own flower, like the steps on the intro card. */
const STAGE_FLOWER: Record<BoardStage, { petal: string; eye: string }> = {
  investigate: UI_FLOWERS.yellow,
  propose: UI_FLOWERS.peach,
  needs_you: UI_FLOWERS.pink,
  vendor: UI_FLOWERS.purple,
  done: UI_FLOWERS.green,
};

function Tag({ stage, item, agent }: { stage: BoardStage; item: Item; agent?: Agent }) {
  const base = "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium";
  if (agent?.status === "working") {
    return (
      <span className={cn(base, "bg-accent text-brand-ink")}>
        <LoaderCircle className="size-3 animate-spin" />
        {AGENT_SHORT[agent.agentId]}
      </span>
    );
  }
  if (agent?.status === "queued") return <span className={cn(base, "bg-accent text-brand-ink")}>Queued</span>;
  if (stage === "needs_you") return <span className={cn(base, "bg-[#ffe7f0] text-[#b4366a]")}>Your turn</span>;
  if (stage === "vendor") return <span className={cn(base, "bg-destructive/10 text-destructive")}>Disputed</span>;
  if (stage === "done") return <Check className="size-4 shrink-0 rounded-full bg-primary p-0.5 text-primary-foreground" />;
  return item.state === "NEW" ? <span className={cn(base, "bg-zinc-100 text-zinc-600")}>New</span> : null;
}

function Card({ item, stage, data, agent }: { item: Item; stage: BoardStage; data: DashboardData; agent?: Agent }) {
  const Icon = item.type === "BILLING_VARIANCE" ? Receipt : Layers;
  const working = agent?.status === "working";
  const variance = item.type === "BILLING_VARIANCE" && item.discrepancyCents >= 100 ? item.discrepancyCents : 0;
  const steps = working ? agentSteps(agent.agentId, agent.runTools, "running").steps : null;
  return (
    <Link
      href={"/canvas?task=" + item.id}
      className={cn("card-soft mx-auto block w-full max-w-[260px] p-3.5 transition-transform hover:-translate-y-px animate-enter", working && "outline-2! outline-primary!", stage === "done" && "opacity-60 hover:opacity-100")}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent">
          <Icon className="size-4 text-brand-ink" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-zinc-900">
            {data.providers[item.providerId]?.shortName} · {item.resource}
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="text-[12.5px] text-zinc-500 tnum">
              {money(item.amountCents, { cents: false })}
              {variance ? <span className="text-destructive"> {money(variance, { sign: true, cents: false })}</span> : null}
            </span>
            <Tag stage={stage} item={item} agent={agent} />
          </div>
        </div>
      </div>
      {steps ? (
        <div className="mt-3 rounded-xl bg-zinc-50 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-zinc-800">
            <AgentAvatar actorId={agent!.agentId} size="sm" className="size-5" />
            {data.actors[agent!.agentId]?.name}
          </div>
          <StepList steps={steps} />
        </div>
      ) : null}
    </Link>
  );
}

function PolicyCard({ p }: { p: DashboardData["policyApprovals"][number] }) {
  return (
    <Link href="/canvas" className="card-soft mx-auto block w-full max-w-[260px] p-3.5 transition-transform hover:-translate-y-px animate-enter">
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[#ffe7f0]">
          <ScrollText className="size-4 text-[#b4366a]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-zinc-900">{p.title}</div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="truncate text-[12.5px] text-zinc-500">Learned at onboarding</span>
            <span className="inline-flex shrink-0 items-center rounded-full bg-[#ffe7f0] px-2 py-0.5 text-[11px] font-medium text-[#b4366a]">Your turn</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

export function Board({ data }: { data: DashboardData }) {
  const agentFor = (id: string) => data.agents.find((a) => a.currentWorkItemId === id && a.status !== "idle");
  return (
    <div className="bg-canvas h-full overflow-auto">
      <div className="flex min-h-full min-w-max px-4 py-6">
        {BOARD_STAGES.map(({ key, label }) => {
          const items = data.workItems.filter((i) => boardStage(i) === key);
          const shown = key === "done" ? items.slice(0, DONE_LIMIT) : items;
          const policyCards = key === "needs_you" ? data.policyApprovals : [];
          return (
            <div key={key} className="flex w-[208px] flex-1 flex-col border-r border-dashed border-zinc-200 px-5 last:border-r-0">
              <div className="mb-3 flex h-8 items-center gap-2">
                <Flower petal={STAGE_FLOWER[key].petal} eye={STAGE_FLOWER[key].eye} size={13} className="-mt-0.5" />
                <span className="text-[14px] font-medium text-zinc-900">{label}</span>
                <span className="text-[13px] text-zinc-400 tnum">{items.length + policyCards.length}</span>
              </div>
              <div className="flex flex-1 flex-col justify-center gap-5 py-6">
                {policyCards.map((p) => (
                  <PolicyCard key={p.approvalId} p={p} />
                ))}
                {shown.map((item) => (
                  <Card key={item.id} item={item} stage={key} data={data} agent={agentFor(item.id)} />
                ))}
                {items.length > shown.length ? <div className="px-1 text-[11.5px] text-zinc-400">+{items.length - shown.length} more</div> : null}
                {items.length + policyCards.length === 0 ? (
                  <div className="grid h-20 place-items-center rounded-2xl border border-dashed border-zinc-200 text-[12.5px] text-zinc-400">Nothing here</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
