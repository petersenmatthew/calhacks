"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { toast } from "sonner";
import { ChevronDown, LayoutDashboard, ShieldCheck } from "lucide-react";
import { fetcher, postJson } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { StatusData } from "@/server/queries";
import { useLiveConnected, useLiveRefresh } from "./live-events";
import { AgentAvatar, AgentStatusPill } from "./status";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const NAV = [
  { href: "/", label: "Operations", icon: LayoutDashboard },
  { href: "/audit", label: "Audit trail", icon: ShieldCheck },
];

const AGENT_NAMES: Record<string, string> = { "agent.compute": "Compute Agent", "agent.finance": "Finance Agent" };

function withoutAgentName(title: string | undefined) {
  return (title ?? "").replace(/^(Compute|Finance) Agent\s*/, "");
}

function ModeSwitcher({ data, onChange }: { data: StatusData | undefined; onChange: () => void }) {
  const settings = data?.settings;
  const llm = settings?.mode === "llm";
  const select = async (mode: "llm" | "deterministic") => {
    try {
      await postJson("/api/settings", { mode });
      onChange();
      toast.success(mode === "llm" ? "New agent runs use the OpenAI Agents SDK" : "New agent runs use deterministic replay");
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md border bg-white px-2.5 py-2 text-left text-xs shadow-xs outline-none hover:bg-zinc-50">
        <span className={cn("size-2 rounded-full", llm ? "bg-emerald-500" : "bg-zinc-400")} />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-zinc-900">{llm ? "LLM agents" : "Deterministic replay"}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {llm ? "OpenAI Agents SDK · " + settings?.model : "Scripted policy · no LLM calls"}
          </span>
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs">Execution mode for new agent runs</DropdownMenuLabel>
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const connected = useLiveConnected();
  const { data, mutate } = useSWR<StatusData>("/api/status", fetcher, { refreshInterval: 15000 });
  useLiveRefresh(() => mutate(), undefined, 400);
  const compact = pathname.startsWith("/investigations");

  return (
    <div className="flex h-dvh overflow-hidden">
      {compact ? <Rail data={data} connected={connected} pathname={pathname} /> : null}
      <aside className={cn("hidden w-[248px] shrink-0 flex-col border-r bg-zinc-50/80", !compact && "md:flex")}>
        <div className="flex h-14 items-center gap-2.5 border-b px-4">
          <span className="grid size-7 place-items-center rounded-md bg-zinc-900 text-[11px] font-semibold tracking-tight text-white">EL</span>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-tight">ExperimentLedger</div>
            <div className="text-[11px] text-muted-foreground">Atlas Research</div>
          </div>
        </div>
        <nav className="space-y-0.5 p-2">
          {NAV.map((item) => {
            const active = item.href === "/" ? pathname === "/" || pathname.startsWith("/investigations") : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors",
                  active ? "bg-white font-medium text-zinc-900 shadow-xs ring-1 ring-zinc-200" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
                )}
              >
                <item.icon className="size-4" />
                <span className="flex-1">{item.label}</span>
                {item.href === "/" && data && data.pendingApprovals > 0 ? (
                  <span className="rounded-full bg-orange-100 px-1.5 text-[10.5px] font-semibold text-orange-700 tnum" title="Pending approvals">
                    {data.pendingApprovals}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="mt-2 px-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Agent team</div>
        <div className="space-y-1 p-2">
          {(data?.agents ?? []).map((agent) => {
            const body = (
              <div className="rounded-md px-2 py-2 hover:bg-zinc-100">
                <div className="flex items-center gap-2">
                  <AgentAvatar actorId={agent.agentId} size="sm" />
                  <span className="flex-1 text-[13px] font-medium">{AGENT_NAMES[agent.agentId]}</span>
                  <AgentStatusPill status={agent.status} />
                </div>
                <div className="mt-1 truncate pl-7 text-[11.5px] text-muted-foreground">
                  {agent.status === "working"
                    ? withoutAgentName(agent.latestAction?.title) || agent.currentTask
                    : agent.status === "queued"
                      ? agent.queued + " run(s) queued"
                      : agent.latestAction
                        ? "Last: " + withoutAgentName(agent.latestAction.title)
                        : "Waiting for work"}
                </div>
              </div>
            );
            return agent.currentWorkItemId ? (
              <Link key={agent.agentId} href={"/investigations/" + agent.currentWorkItemId} className="block">
                {body}
              </Link>
            ) : (
              <div key={agent.agentId}>{body}</div>
            );
          })}
        </div>

        <div className="mt-auto space-y-3 border-t p-3">
          <ModeSwitcher data={data} onChange={() => mutate()} />
          <div className="flex items-center gap-2 px-0.5">
            <AgentAvatar actorId="human.controller" size="sm" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-xs font-medium">Priya Natarajan</div>
              <div className="text-[11px] text-muted-foreground">Controller</div>
            </div>
            <span
              title={connected ? "Live updates connected" : "Reconnecting to live updates"}
              className={cn("size-2 rounded-full", connected ? "bg-emerald-500" : "bg-zinc-300")}
            />
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center gap-3 border-b px-4 md:hidden">
          <span className="grid size-6 place-items-center rounded bg-zinc-900 text-[10px] font-semibold text-white">EL</span>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="text-[13px] text-zinc-700">
              {item.label}
            </Link>
          ))}
        </header>
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  );
}


function RailIcon({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="max-w-[240px]">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Slim navigation rail used on the investigation workspace to give the timeline room. */
function Rail({ data, connected, pathname }: { data: StatusData | undefined; connected: boolean; pathname: string }) {
  return (
    <aside className="hidden w-[56px] shrink-0 flex-col items-center gap-1 border-r bg-zinc-50/80 py-3 md:flex">
      <Link href="/" className="mb-2 grid size-8 place-items-center rounded-md bg-zinc-900 text-[11px] font-semibold text-white">
        EL
      </Link>
      {NAV.map((item) => {
        const active = item.href === "/" ? pathname === "/" || pathname.startsWith("/investigations") : pathname.startsWith(item.href);
        return (
          <RailIcon key={item.href} label={item.label}>
            <Link
              href={item.href}
              className={cn(
                "relative grid size-9 place-items-center rounded-md",
                active ? "bg-white text-zinc-900 shadow-xs ring-1 ring-zinc-200" : "text-zinc-500 hover:bg-zinc-100",
              )}
            >
              <item.icon className="size-4" />
              {item.href === "/" && data && data.pendingApprovals > 0 ? (
                <span className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-orange-500 text-[9px] font-semibold text-white">
                  {data.pendingApprovals}
                </span>
              ) : null}
            </Link>
          </RailIcon>
        );
      })}
      <div className="my-2 h-px w-6 bg-zinc-200" />
      {(data?.agents ?? []).map((agent) => (
        <RailIcon
          key={agent.agentId}
          label={
            <span>
              <span className="font-medium">{AGENT_NAMES[agent.agentId]}</span> · {agent.status}
              <br />
              {withoutAgentName(agent.latestAction?.title) || "Waiting for work"}
            </span>
          }
        >
          <span className="relative grid size-9 place-items-center">
            <AgentAvatar actorId={agent.agentId} />
            <span
              className={cn(
                "absolute right-1 bottom-1 size-2.5 rounded-full ring-2 ring-zinc-50",
                agent.status === "working" ? "animate-pulse bg-blue-500" : agent.status === "queued" ? "bg-amber-500" : "bg-zinc-300",
              )}
            />
          </span>
        </RailIcon>
      ))}
      <div className="mt-auto flex flex-col items-center gap-2">
        <RailIcon label={data?.settings.mode === "llm" ? "LLM agents · " + data.settings.model : "Deterministic replay · no LLM calls"}>
          <span className={cn("size-2 rounded-full", data?.settings.mode === "llm" ? "bg-emerald-500" : "bg-zinc-400")} />
        </RailIcon>
        <RailIcon label={"Priya Natarajan, Controller" + (connected ? " · live" : " · reconnecting")}>
          <span>
            <AgentAvatar actorId="human.controller" size="sm" />
          </span>
        </RailIcon>
      </div>
    </aside>
  );
}

