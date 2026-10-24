"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { toast } from "sonner";
import { ChevronsUpDown, LayoutList, ShieldCheck } from "lucide-react";
import { agentSteps } from "@/lib/agent-steps";
import { fetcher, postJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { StatusData } from "@/server/queries";
import { useLiveConnected, useLiveRefresh } from "./live-events";
import { AgentAvatar, AgentStatusText } from "./status";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const NAV = [
  { href: "/", label: "Work", icon: LayoutList },
  { href: "/audit", label: "Audit trail", icon: ShieldCheck },
];

const AGENT_NAMES: Record<string, string> = { "agent.compute": "Compute Agent", "agent.finance": "Finance Agent" };

function isActive(href: string, pathname: string) {
  return href === "/" ? pathname === "/" || pathname.startsWith("/investigations") : pathname.startsWith(href);
}

function ModeSwitcher({ data, onChange }: { data: StatusData | undefined; onChange: () => void }) {
  const settings = data?.settings;
  const llm = settings?.mode === "llm";
  const select = async (mode: "llm" | "deterministic") => {
    try {
      await postJson("/api/settings", { mode });
      onChange();
      toast.success(mode === "llm" ? "New agent runs use LLM agents" : "New agent runs use deterministic replay");
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] outline-none hover:bg-zinc-100">
        <span className={cn("size-2 rounded-full", llm ? "bg-emerald-500" : "bg-zinc-400")} />
        <span className="min-w-0 flex-1 truncate text-zinc-700">{llm ? "LLM agents · " + settings?.model : "Deterministic replay"}</span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs">How new agent runs decide</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!settings?.llmAvailable} onSelect={() => select("llm")} className="flex-col items-start gap-0.5">
          <span className="text-[13px] font-medium">LLM agents</span>
          <span className="text-[11px] text-muted-foreground">
            {settings?.llmAvailable ? "OpenAI Agents SDK · " + settings.model : "Set OPENAI_API_KEY on the server to enable"}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => select("deterministic")} className="flex-col items-start gap-0.5">
          <span className="text-[13px] font-medium">Deterministic replay</span>
          <span className="text-[11px] text-muted-foreground">Same tools and controls, scripted decisions</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AgentRow({ agent }: { agent: StatusData["agents"][number] }) {
  const busy = agent.status !== "idle";
  const detail =
    agent.status === "working"
      ? agentSteps(agent.agentId, agent.runTools, "running").current?.verb ?? "Working"
      : agent.status === "queued"
        ? "Next: " + agent.currentWorkItemId
        : null;
  const body = (
    <div className="rounded-md px-2 py-1.5 hover:bg-zinc-100">
      <div className="flex items-center gap-2">
        <AgentAvatar actorId={agent.agentId} size="sm" />
        <span className="flex-1 truncate text-[13px] text-zinc-800">{AGENT_NAMES[agent.agentId] ?? agent.agentId}</span>
        <AgentStatusText status={agent.status} label={agent.status === "queued" ? agent.queued + " queued" : undefined} />
      </div>
      {busy && detail ? (
        <div className="mt-0.5 truncate pl-7 text-[11.5px] text-muted-foreground">
          {agent.status === "working" && agent.currentWorkItemId ? <span className="font-mono">{agent.currentWorkItemId} · </span> : null}
          {detail}
        </div>
      ) : null}
    </div>
  );
  return agent.currentWorkItemId && busy ? (
    <Link href={"/investigations/" + agent.currentWorkItemId} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const connected = useLiveConnected();
  const { data, mutate } = useSWR<StatusData>("/api/status", fetcher, { refreshInterval: 15000 });
  useLiveRefresh(() => mutate(), undefined, 400);

  const agents = data?.agents ?? [];
  const needsYou = (data?.pendingApprovals ?? 0) + (data?.needsInfo ?? 0);
  const running = agents.filter((a) => a.status === "working").length;
  const queued = agents.reduce((s, a) => s + a.queued, 0);
  const agentSummary = running || queued ? [running ? running + " running" : null, queued ? queued + " queued" : null].filter(Boolean).join(" · ") : "All idle";

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-[232px] shrink-0 flex-col border-r bg-zinc-50/70 md:flex">
        <div className="flex h-12 items-center gap-2.5 px-4">
          <span className="grid size-6 place-items-center rounded-md bg-zinc-900 text-[10px] font-semibold text-white">EL</span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold tracking-tight">ExperimentLedger</div>
            <div className="truncate text-[11px] text-muted-foreground">Atlas Research</div>
          </div>
        </div>

        <nav className="space-y-px px-2 pt-1">
          {NAV.map((item) => {
            const active = isActive(item.href, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px]",
                  active ? "bg-zinc-200/60 font-medium text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
                )}
              >
                <item.icon className="size-4 text-zinc-500" />
                <span className="flex-1">{item.label}</span>
                {item.href === "/" && needsYou > 0 ? (
                  <span title="Waiting on your decision" className="rounded-full bg-orange-500 px-1.5 text-[10.5px] leading-[18px] font-semibold text-white tnum">
                    {needsYou}
                  </span>
                ) : item.href === "/" && data?.openItems ? (
                  <span title="Open work items" className="text-[11.5px] text-muted-foreground tnum">
                    {data.openItems}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="mt-5 flex items-center justify-between px-4 pb-1 text-[11.5px]">
          <span className="font-medium text-zinc-500">Agents</span>
          <span className={cn("tnum", running ? "text-blue-700" : "text-muted-foreground")}>{agentSummary}</span>
        </div>
        <div className="space-y-px px-2">
          {agents.map((agent) => (
            <AgentRow key={agent.agentId} agent={agent} />
          ))}
        </div>

        <div className="mt-auto space-y-1 border-t p-2">
          <ModeSwitcher data={data} onChange={() => mutate()} />
          <div className="flex h-8 items-center gap-2 px-2">
            <AgentAvatar actorId="human.controller" size="sm" />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-700">Priya Natarajan</span>
            <span
              title={connected ? "Live updates connected" : "Reconnecting to live updates"}
              className={cn("size-2 rounded-full", connected ? "bg-emerald-500" : "bg-zinc-300")}
            />
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-4 border-b px-4 md:hidden">
          <span className="grid size-6 place-items-center rounded bg-zinc-900 text-[10px] font-semibold text-white">EL</span>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="flex items-center gap-1.5 text-[13px] text-zinc-700">
              {item.label}
              {item.href === "/" && needsYou > 0 ? (
                <span className="rounded-full bg-orange-500 px-1.5 text-[10.5px] font-semibold text-white tnum">{needsYou}</span>
              ) : null}
            </Link>
          ))}
          <span className="ml-auto text-[11.5px] text-muted-foreground">{agentSummary}</span>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}
