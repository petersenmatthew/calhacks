"use client";

import { agentSteps } from "@/lib/agent-steps";
import type { DashboardData } from "@/server/queries";
import { AgentAvatar } from "../status";

/** One short line at the bottom of the view saying what is happening now. */
export function Caption({ data }: { data: DashboardData }) {
  const working = data.agents.find((a) => a.status === "working");
  const needsYou = data.workItems.filter((i) => i.pendingApproval || i.state === "NEEDS_APPROVAL" || i.state === "NEEDS_INFO").length;
  let content: React.ReactNode;
  if (working) {
    const step = agentSteps(working.agentId, working.runTools, "running").current;
    content = (
      <>
        <AgentAvatar actorId={working.agentId} size="sm" />
        <span>{step?.verb ?? "Working"}</span>
        <span className="font-mono text-[11.5px] text-white/60">{working.currentWorkItemId}</span>
      </>
    );
  } else if (needsYou) {
    content = (
      <>
        <span className="size-2 rounded-full bg-orange-400" />
        <span>{needsYou === 1 ? "1 decision waiting on you" : needsYou + " decisions waiting on you"}</span>
      </>
    );
  } else {
    content = (
      <>
        <span className="size-2 rounded-full bg-emerald-400" />
        <span>All agents idle</span>
      </>
    );
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center">
      <div className="flex items-center gap-2.5 rounded-xl bg-zinc-900/75 px-4 py-2.5 text-[13.5px] text-white shadow-lg backdrop-blur animate-enter">{content}</div>
    </div>
  );
}
