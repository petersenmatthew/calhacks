"use client";

import { agentSteps } from "@/lib/agent-steps";
import type { DashboardData } from "@/server/queries";
import { AgentAvatar } from "../status";

/** One short line at the bottom of the view, shown only while an agent is working. */
export function Caption({ data }: { data: DashboardData }) {
  const working = data.agents.find((a) => a.status === "working");
  if (!working) return null;
  const step = agentSteps(working.agentId, working.runTools, "running").current;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center">
      <div className="flex items-center gap-2.5 rounded-xl bg-zinc-900/75 px-4 py-2.5 text-[13.5px] text-white shadow-lg backdrop-blur animate-enter">
        <AgentAvatar actorId={working.agentId} size="sm" />
        <span>{step?.verb ?? "Working"}</span>
        <span className="font-mono text-[11.5px] text-white/60">{working.currentWorkItemId}</span>
      </div>
    </div>
  );
}
