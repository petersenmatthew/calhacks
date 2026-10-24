"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BookCheck, Building2, Check, Inbox, LoaderCircle, User } from "lucide-react";
import { agentSteps, boardStage, type BoardStage } from "@/lib/agent-steps";
import { cn } from "@/lib/utils";
import type { DashboardData } from "@/server/queries";
import { StepList } from "../agent-steps";
import { AgentAvatar } from "../status";

const W = 1000;
const H = 520;

const POS = {
  intake: [80, 250],
  compute: [300, 250],
  finance: [560, 250],
  you: [790, 100],
  ledger: [900, 250],
  vendor: [900, 410],
} as const;

function useFitScale(w: number, h: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setScale(Math.max(0.5, Math.min(width / w, (height - 60) / h, 1.25)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);
  return { ref, scale };
}

type Tone = "blue" | "orange" | "red" | "idle";

function Edge({ d, tone = "idle", dashed }: { d: string; tone?: Tone; dashed?: boolean }) {
  const color = tone === "blue" ? "#3b82f6" : tone === "orange" ? "#f97316" : tone === "red" ? "#f43f5e" : "#d4d4d8";
  const animated = tone === "blue" || tone === "orange";
  return (
    <path
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={animated ? 1.75 : 1.25}
      className={animated ? "flow-dash" : undefined}
      strokeDasharray={!animated && dashed ? "3 5" : undefined}
    />
  );
}

function Badge({ count, tone, spin }: { count: number; tone: Tone; spin?: boolean }) {
  if (!count && !spin) return null;
  return (
    <span
      className={cn(
        "absolute -top-3 -left-2 flex h-6 items-center gap-1 rounded-full bg-white px-2 text-[11.5px] font-medium shadow-sm ring-1 ring-zinc-200 tnum",
        tone === "blue" && "text-blue-600",
        tone === "orange" && "text-orange-600",
        tone === "red" && "text-rose-600",
        tone === "idle" && "text-zinc-500",
      )}
    >
      {spin ? <LoaderCircle className="size-3 animate-spin" /> : <span className="size-1.5 rounded-full bg-current" />}
      {count}
    </span>
  );
}

function Chips({ items }: { items: DashboardData["workItems"] }) {
  if (!items.length) return null;
  return (
    <div className="absolute top-full left-1/2 mt-2.5 flex -translate-x-1/2 gap-1">
      {items.slice(0, 3).map((i) => (
        <Link key={i.id} href={"/investigations/" + i.id} className="rounded-md bg-white px-1.5 py-0.5 font-mono text-[10.5px] whitespace-nowrap text-zinc-600 shadow-xs ring-1 ring-zinc-200 hover:text-zinc-900">
          {i.id}
        </Link>
      ))}
      {items.length > 3 ? <span className="px-1 text-[10.5px] text-zinc-400">+{items.length - 3}</span> : null}
    </div>
  );
}

function Node({ at, children }: { at: readonly [number, number]; children: React.ReactNode }) {
  return (
    <div className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: at[0], top: at[1] }}>
      {children}
    </div>
  );
}

function Pill({
  icon: Icon,
  label,
  badge,
  items,
  href,
  highlight,
}: {
  icon: typeof Inbox;
  label: string;
  badge?: React.ReactNode;
  items?: DashboardData["workItems"];
  href?: string | null;
  highlight?: Tone;
}) {
  const body = (
    <div
      className={cn(
        "card-soft relative flex items-center gap-2 px-4 py-2.5 text-[14px] font-medium whitespace-nowrap text-zinc-800",
        highlight === "orange" && "outline-2! outline-orange-300!",
        highlight === "red" && "outline-rose-300!",
      )}
    >
      <Icon className="size-4 text-zinc-500" />
      {label}
      {badge}
    </div>
  );
  return (
    <div className="relative">
      {href ? <Link href={href}>{body}</Link> : body}
      {items ? <Chips items={items} /> : null}
    </div>
  );
}

function AgentNode({ data, agentId, items }: { data: DashboardData; agentId: string; items: DashboardData["workItems"] }) {
  const agent = data.agents.find((a) => a.agentId === agentId);
  const working = agent?.status === "working";
  const { steps } = agentSteps(agentId, agent?.runTools ?? [], working ? "running" : "none");
  const href = agent?.currentWorkItemId ? "/investigations/" + agent.currentWorkItemId : items[0] ? "/investigations/" + items[0].id : null;
  const body = (
    <div className={cn("card-soft relative w-[210px] p-3.5 transition-shadow", working && "outline-2! outline-blue-300!")}>
      <div className="flex items-center gap-2.5">
        <AgentAvatar actorId={agentId} />
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-zinc-900">{data.actors[agentId]?.name}</div>
          <div className="font-mono text-[11px] text-zinc-400">{working ? agent?.currentWorkItemId : agent?.status === "queued" ? agent.queued + " queued" : "Idle"}</div>
        </div>
      </div>
      <div className={cn("mt-3 rounded-lg px-2.5 py-2 ring-1", working ? "bg-zinc-50 ring-zinc-200" : "ring-zinc-100")}>
        <StepList steps={steps} />
      </div>
      <Badge count={items.length} tone={working ? "blue" : "idle"} spin={working} />
    </div>
  );
  return (
    <div className="relative">
      {href ? <Link href={href}>{body}</Link> : body}
      <Chips items={items.filter((i) => i.id !== agent?.currentWorkItemId || !working)} />
    </div>
  );
}

export function SystemCanvas({ data }: { data: DashboardData }) {
  const { ref, scale } = useFitScale(W, H);
  const at = (stage: BoardStage) => data.workItems.filter((i) => boardStage(i) === stage);
  const compute = at("investigate");
  const finance = at("propose");
  const you = at("needs_you");
  const vendor = at("vendor");
  const computeWorking = data.agents.some((a) => a.agentId === "agent.compute" && a.status === "working");
  const financeWorking = data.agents.some((a) => a.agentId === "agent.finance" && a.status === "working");
  const m = data.metrics;
  const [ix, iy] = POS.intake;
  const [cx] = POS.compute;
  const [fx, fy] = POS.finance;
  const [yx, yy] = POS.you;
  const [lx, ly] = POS.ledger;
  const [vx, vy] = POS.vendor;

  return (
    <div ref={ref} className="bg-dots relative h-full w-full overflow-hidden">
      <div className="absolute top-1/2 left-1/2" style={{ width: W, height: H, transform: "translate(-50%, -50%) scale(" + scale + ")" }}>
        <svg width={W} height={H} className="absolute inset-0 overflow-visible">
          <Edge d={"M" + ix + "," + iy + " L" + cx + "," + iy} tone={computeWorking ? "blue" : "idle"} />
          <Edge d={"M" + cx + "," + iy + " L" + fx + "," + fy} tone={financeWorking ? "blue" : "idle"} />
          <Edge d={"M" + fx + "," + fy + " C" + (fx + 120) + "," + fy + " " + (yx - 110) + "," + yy + " " + yx + "," + yy} tone={you.length ? "orange" : "idle"} />
          <Edge d={"M" + yx + "," + yy + " C" + lx + "," + yy + " " + lx + "," + (yy + 50) + " " + lx + "," + ly} />
          <Edge d={"M" + fx + "," + fy + " L" + lx + "," + ly} dashed />
          <Edge d={"M" + lx + "," + ly + " L" + vx + "," + vy} tone={vendor.length ? "red" : "idle"} dashed={!vendor.length} />
          <Edge d={"M" + ix + "," + iy + " C" + ix + "," + (iy + 230) + " " + (lx - 140) + "," + (ly + 230) + " " + lx + "," + ly} dashed />
          <text x={(ix + lx) / 2 - 20} y={iy + 190} textAnchor="middle" className="fill-zinc-400 text-[11px]">
            {m.autoMatched} auto-matched
          </text>
          <text x={(fx + lx) / 2 + 60} y={fy + 16} textAnchor="middle" className="fill-zinc-400 text-[11px]">
            policy
          </text>
        </svg>

        <Node at={POS.intake}>
          <Pill icon={Inbox} label="Invoices" badge={<Badge count={m.lineCount} tone="idle" />} />
        </Node>
        <Node at={POS.compute}>
          <AgentNode data={data} agentId="agent.compute" items={compute} />
        </Node>
        <Node at={POS.finance}>
          <AgentNode data={data} agentId="agent.finance" items={finance} />
        </Node>
        <Node at={POS.you}>
          <Pill
            icon={User}
            label="You"
            items={you}
            href={you[0] ? "/investigations/" + you[0].id : null}
            highlight={you.length ? "orange" : undefined}
            badge={<Badge count={you.length} tone="orange" />}
          />
        </Node>
        <Node at={POS.ledger}>
          <Pill
            icon={BookCheck}
            label="Ledger"
            href="/audit"
            badge={
              <span className="absolute -top-3 -left-2 flex h-6 items-center gap-1 rounded-full bg-white px-2 text-[11.5px] font-medium text-emerald-700 shadow-sm ring-1 ring-zinc-200 tnum">
                <Check className="size-3" />
                {m.completedReconciliations}
              </span>
            }
          />
        </Node>
        <Node at={POS.vendor}>
          <Pill
            icon={Building2}
            label="Vendor"
            items={vendor}
            href={vendor[0] ? "/investigations/" + vendor[0].id : null}
            highlight={vendor.length ? "red" : undefined}
            badge={<Badge count={vendor.length} tone="red" />}
          />
        </Node>
      </div>
    </div>
  );
}
