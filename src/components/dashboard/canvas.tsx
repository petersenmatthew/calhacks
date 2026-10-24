"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import useSWR from "swr";
import { ArrowUpRight, BookCheck, Building2, ChevronDown, Inbox, LoaderCircle, User } from "lucide-react";
import { agentSteps, boardStage, type BoardStage } from "@/lib/agent-steps";
import { fetcher } from "@/lib/api";
import { clockTime, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { DashboardData, WorkspaceData } from "@/server/queries";
import { StepList } from "../agent-steps";
import { useLiveRefresh } from "../live-events";
import { AgentAvatar, StateBadge } from "../status";
import { EvidenceDialog } from "../workspace/evidence-dialog";
import { SubtaskDialog, type SubtaskSelection } from "../workspace/subtask-dialog";
import { PROJECT_COLORS, WorkspaceContext } from "../workspace/workspace-context";

/* ------------------------------------------------------------------ layout */

// The stage is drawn in a fixed coordinate space and scaled to fit the viewport.
const W = 1200;
const H = 760;
const CX = W / 2;
const CY = H / 2;
const R = 250;

type NodeId = "intake" | "agent.compute" | "agent.finance" | "ledger" | "vendor";

const ANGLE: Record<NodeId, number> = {
  intake: 180,
  "agent.compute": -108,
  "agent.finance": -36,
  ledger: 36,
  vendor: 108,
};

function pos(id: NodeId | "you") {
  if (id === "you") return { x: CX, y: CY };
  const a = (ANGLE[id] * Math.PI) / 180;
  return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
}

const CARD_W = 280;
const CHIP_W = 170;
const PILL_HALF = 78;
/** Where each node's workspace sits: which side of the node, and its anchor edge x / top y. */
const CARD: Partial<Record<NodeId, { side: "left" | "right"; x: number; y: number }>> = {
  "agent.compute": { side: "left", x: pos("agent.compute").x - 110, y: pos("agent.compute").y - 16 },
  "agent.finance": { side: "right", x: pos("agent.finance").x + 110, y: pos("agent.finance").y - 16 },
  ledger: { side: "right", x: pos("ledger").x + 110, y: pos("ledger").y - 16 },
};

/** A gentle arc between two points, bowing away from the centre. */
function arc(a: { x: number; y: number }, b: { x: number; y: number }) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  if ((mx + nx - CX) ** 2 + (my + ny - CY) ** 2 < (mx - CX) ** 2 + (my - CY) ** 2) {
    nx = -nx;
    ny = -ny;
  }
  const k = len * 0.22;
  return `M ${a.x} ${a.y} Q ${mx + nx * k} ${my + ny * k} ${b.x} ${b.y}`;
}

/** Level dotted line from a node's pill across to its workspace card. */
function feed(id: NodeId) {
  const c = CARD[id]!;
  const p = pos(id);
  const dir = c.side === "right" ? 1 : -1;
  return `M ${p.x + dir * PILL_HALF} ${p.y} L ${c.x} ${p.y}`;
}

const FINANCE_SOURCES = new Set(["budget", "policy", "precedent", "calculation"]);

/* ------------------------------------------------------------------ state */

type EdgeState = "idle" | "done" | "active";
type Edge = { from: NodeId | "you"; to: NodeId | "you"; state: EdgeState };

function lastRun(w: WorkspaceData, agentId: string) {
  const run = w.runs.filter((r) => r.agentId === agentId).at(-1);
  const tools = run ? w.activity.filter((e) => e.runId === run.id && e.toolName).map((e) => e.toolName!) : [];
  const status = run?.status === "running" || run?.status === "completed" || run?.status === "failed" ? run.status : "none";
  const queued = w.agents.some((a) => a.agentId === agentId && a.status === "queued" && a.currentWorkItemId === w.item.id);
  return { run, status, queued, ...agentSteps(agentId, tools, status) } as const;
}

function edgesFor(w?: WorkspaceData): Edge[] {
  if (!w) {
    return [
      { from: "intake", to: "agent.compute", state: "idle" },
      { from: "agent.compute", to: "agent.finance", state: "idle" },
    ];
  }
  const compute = lastRun(w, "agent.compute");
  const finance = lastRun(w, "agent.finance");
  const pending = w.approvals.some((a) => a.status === "PENDING") || w.item.state === "NEEDS_INFO";
  const posted = w.journal.some((e) => e.source !== "erp_ap");
  const decided = w.approvals.some((a) => a.status !== "PENDING");
  const handingOff = compute.current?.label === "Hand off" || finance.queued || finance.status === "running";
  return [
    { from: "intake", to: "agent.compute", state: compute.status === "running" && !handingOff ? "active" : compute.status !== "none" ? "done" : "idle" },
    { from: "agent.compute", to: "agent.finance", state: handingOff && finance.status !== "completed" ? "active" : finance.status !== "none" ? "done" : "idle" },
    { from: "agent.finance", to: "you", state: pending ? "active" : decided ? "done" : "idle" },
    { from: "you", to: "ledger", state: w.item.state === "APPROVED" ? "active" : posted ? "done" : "idle" },
    { from: "you", to: "vendor", state: w.dispute?.status === "SUBMITTED" ? "active" : w.dispute ? "done" : "idle" },
  ];
}

/* ------------------------------------------------------------------ svg */

function Flow({ d, active }: { d: string; active: boolean }) {
  if (!active) return <path d={d} stroke="var(--primary)" strokeWidth={1.25} strokeDasharray="2 5" opacity={0.45} fill="none" />;
  return (
    <g>
      <path d={d} stroke="var(--primary)" strokeWidth={8} opacity={0.18} fill="none" />
      <path d={d} stroke="var(--primary)" strokeWidth={2.25} fill="none" className="flow-dash" />
      {[0, 0.5].map((delay) => (
        <circle key={delay} r={3.5} fill="var(--brand-ink)">
          <animateMotion dur="1.4s" begin={delay * 1.4 + "s"} repeatCount="indefinite" path={d} />
        </circle>
      ))}
    </g>
  );
}

function Wires({ edges, open }: { edges: Edge[]; open: NodeId | null }) {
  return (
    <svg aria-hidden="true" width={W} height={H} className="pointer-events-none absolute inset-0 overflow-visible">
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="#ececef" strokeWidth={1} />
      {edges
        .filter((e) => e.state !== "idle")
        .map((e) => (
          <Flow key={e.from + e.to} d={arc(pos(e.from), pos(e.to))} active={e.state === "active"} />
        ))}
      {(Object.keys(CARD) as NodeId[]).map((id) => (
        <Flow key={"feed-" + id} d={feed(id)} active={open === id} />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ nodes */

type Hover = { open: NodeId | null; enter: (id: NodeId) => void; leave: () => void };

function At({ x, y, children, className, onEnter, onLeave }: { x: number; y: number; children: ReactNode; className?: string; onEnter?: () => void; onLeave?: () => void }) {
  return (
    <div className={cn("absolute -translate-x-1/2 -translate-y-1/2", className)} style={{ left: x, top: y }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {children}
    </div>
  );
}

function Badge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="absolute -top-7 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-md bg-white px-1.5 py-0.5 font-mono text-[11px] text-zinc-600 shadow-xs ring-1 ring-zinc-200 tnum">
      <span className="size-1.5 rounded-full bg-zinc-400" />
      {count}
    </span>
  );
}

function NodePill({ id, icon, label, count, live, href, hover }: { id: NodeId; icon: ReactNode; label: string; count: number; live?: boolean; href?: string; hover?: Hover }) {
  const p = pos(id);
  const body = (
    <span
      className={cn(
        "relative flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-[13px] font-medium whitespace-nowrap text-zinc-800 shadow-sm ring-1 ring-zinc-200",
        live && "ring-2 ring-primary",
        href && "hover:ring-zinc-400",
      )}
    >
      <Badge count={count} />
      {icon}
      {label}
      {live ? <LoaderCircle className="size-3.5 animate-spin text-brand-ink" /> : null}
    </span>
  );
  return (
    <At x={p.x} y={p.y} className="z-20" {...(hover ? { onEnter: () => hover.enter(id), onLeave: hover.leave } : {})}>
      {href ? <Link href={href}>{body}</Link> : body}
    </At>
  );
}

function You({ overview, w }: { overview: DashboardData; w?: WorkspaceData }) {
  const waiting = overview.workItems.filter((i) => boardStage(i) === "needs_you");
  const here = w && (w.approvals.some((a) => a.status === "PENDING") || w.item.state === "NEEDS_INFO");
  const body = (
    <div
      className={cn(
        "relative flex w-[150px] flex-col items-center gap-1 rounded-2xl bg-white px-4 py-4 shadow-md ring-1 ring-zinc-200",
        waiting.length && "ring-2 ring-primary",
      )}
    >
      {waiting.length ? <span className="absolute -top-1 -right-1 size-3 animate-pulse rounded-full bg-primary ring-2 ring-white" /> : null}
      <User className="size-5 text-zinc-700" />
      <span className="text-[16px] font-semibold tracking-tight">You</span>
      <span className="text-[11.5px] text-muted-foreground">
        {waiting.length ? (here ? "Review " + w!.item.id : waiting.length + " waiting") : "Nothing waiting"}
      </span>
    </div>
  );
  return <At x={CX} y={CY}>{body}</At>;
}

/* ------------------------------------------------------------------ workspaces */

function Card({ id, title, status, hover, children }: { id: NodeId; title: string; status?: ReactNode; hover: Hover; children: ReactNode }) {
  const c = CARD[id]!;
  const open = hover.open === id;
  return (
    <div
      onMouseEnter={() => hover.enter(id)}
      onMouseLeave={hover.leave}
      className={cn("card-soft absolute overflow-hidden transition-[width,box-shadow] duration-300 ease-out", open ? "z-30 shadow-lg" : "z-10")}
      style={{ [c.side === "right" ? "left" : "right"]: c.side === "right" ? c.x : W - c.x, top: c.y, width: open ? CARD_W : CHIP_W }}
    >
      <div className={cn("flex h-8 items-center gap-2 px-3", open && "border-b bg-zinc-50/80")}>
        <span className="flex gap-1">
          <span className="size-1.5 rounded-full bg-zinc-300" />
          <span className="size-1.5 rounded-full bg-zinc-300" />
          <span className="size-1.5 rounded-full bg-zinc-300" />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] tracking-wider text-zinc-500 uppercase">{title}</span>
        {status}
      </div>
      <div className={cn("grid transition-[grid-template-rows] duration-300 ease-out", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="min-h-0 overflow-hidden">
          <div className="p-3" style={{ width: CARD_W }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

function RunStatus({ status, verb, queued }: { status: string; verb?: string; queued?: boolean }) {
  if (status === "running")
    return (
      <span className="flex items-center gap-1 text-[10.5px] font-medium text-brand-ink">
        <LoaderCircle className="size-3 animate-spin" />
        {verb ?? "Working"}
      </span>
    );
  if (queued) return <span className="text-[10.5px] text-zinc-500">Queued</span>;
  if (status === "completed") return <span className="text-[10.5px] text-zinc-500">Done</span>;
  if (status === "failed") return <span className="text-[10.5px] text-destructive">Failed</span>;
  return null;
}

const ROWS = 5;

/** A small sheet that fills in row by row; empty slots stay as faint placeholders. */
function Sheet({ rows, empty }: { rows: { key: string; cells: ReactNode[]; onClick?: () => void }[]; empty: string }) {
  const shown = rows.slice(-ROWS);
  const blanks = Math.max(0, ROWS - shown.length);
  return (
    <div className="overflow-hidden rounded-md ring-1 ring-zinc-200">
      {rows.length > ROWS ? <div className="border-b bg-zinc-50 px-2 py-0.5 text-[10px] text-zinc-400">+{rows.length - ROWS} earlier</div> : null}
      {shown.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={r.onClick}
          disabled={!r.onClick}
          className="flex h-6 w-full items-center gap-2 border-b px-2 text-left text-[11px] last:border-b-0 enabled:hover:bg-zinc-50 animate-enter"
        >
          {r.cells.map((c, i) => (
            <span key={i} className={cn(i === 0 ? "min-w-0 flex-1 truncate text-zinc-700" : "shrink-0 text-zinc-500 tnum")}>
              {c}
            </span>
          ))}
        </button>
      ))}
      {Array.from({ length: blanks }).map((_, i) => (
        <div key={i} className="flex h-6 items-center border-b px-2 last:border-b-0">
          {i === 0 && !rows.length ? (
            <span className="text-[10.5px] text-zinc-400">{empty}</span>
          ) : (
            <span className="h-1.5 rounded-full bg-zinc-100" style={{ width: 40 + ((i * 37) % 45) + "%" }} />
          )}
        </div>
      ))}
    </div>
  );
}

function AgentWorkspace({ id, w, onStep, openEvidence, hover }: { id: "agent.compute" | "agent.finance"; w?: WorkspaceData; onStep: (s: SubtaskSelection) => void; openEvidence: (id: string) => void; hover: Hover }) {
  const r = w ? lastRun(w, id) : null;
  const steps = r?.steps ?? agentSteps(id, [], "none").steps;
  const finance = id === "agent.finance";
  const evidence = (w?.evidence ?? []).filter((e) => FINANCE_SOURCES.has(e.sourceType) === finance);
  const proposal = finance ? w?.proposals.at(-1) : undefined;

  let sheet: ReactNode;
  if (proposal?.payload.dispute) {
    const d = proposal.payload.dispute;
    sheet = (
      <Sheet
        empty=""
        rows={[
          { key: "inv", cells: ["Invoiced", money(d.invoicedCents)] },
          { key: "ok", cells: ["Supported", money(d.undisputedCents)] },
          { key: "bad", cells: ["Disputed", <span key="d" className="text-destructive">{money(d.disputedCents)}</span>] },
        ]}
      />
    );
  } else if (proposal) {
    sheet = (
      <Sheet
        empty=""
        rows={[
          ...proposal.payload.allocation.map((l) => ({
            key: l.projectId,
            cells: [
              <span key="n" className="flex items-center gap-1.5">
                <span className={cn("size-2 shrink-0 rounded-sm", PROJECT_COLORS[l.projectId]?.dot ?? "bg-zinc-400")} />
                {w!.projects[l.projectId]?.name ?? l.projectId}
              </span>,
              money(l.amountCents),
            ],
          })),
          { key: "total", cells: [<span key="t" className="font-medium">Total</span>, <span key="v" className="font-medium text-zinc-800">{money(proposal.payload.totalCents)}</span>] },
        ]}
      />
    );
  } else {
    sheet = (
      <Sheet
        empty={w ? "Waiting for records" : "No investigation selected"}
        rows={evidence.map((e) => ({ key: e.id, cells: [e.label, clockTime(e.createdAt)], onClick: () => openEvidence(e.id) }))}
      />
    );
  }

  return (
    <Card
      id={id}
      hover={hover}
      title={finance ? (proposal ? (proposal.kind === "VENDOR_DISPUTE" ? "Dispute" : "Allocation") + " v" + proposal.version : "Policy workbook") : "Evidence workbook"}
      status={r ? <RunStatus status={r.status} verb={r.current?.verb} queued={r.queued} /> : null}
    >
      <StepList steps={steps} className="mb-2.5 text-[11px]" onSelect={w ? (label) => onStep({ agentId: id, label, runId: r?.run?.id ?? null }) : undefined} />
      {sheet}
    </Card>
  );
}

function LedgerWorkspace({ w, hover }: { w?: WorkspaceData; hover: Hover }) {
  const entries = (w?.journal ?? []).filter((e) => e.source !== "erp_ap");
  return (
    <Card id="ledger" title="Journal" hover={hover} status={entries.length ? <span className="text-[10.5px] text-zinc-500 tnum">{entries.length}</span> : null}>
      <Sheet empty="Nothing posted yet" rows={entries.map((e) => ({ key: e.id, cells: [e.memo, money(e.totalCents)] }))} />
    </Card>
  );
}

/* ------------------------------------------------------------------ stage */

function useFit() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(Math.min(e.contentRect.width / W, e.contentRect.height / H, 1.25)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, scale };
}

function Radial({ overview, w, openEvidence }: { overview: DashboardData; w?: WorkspaceData; openEvidence: (id: string) => void }) {
  const { ref, scale } = useFit();
  const [subtask, setSubtask] = useState<SubtaskSelection | null>(null);
  const [open, setOpen] = useState<NodeId | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hover: Hover = {
    open,
    enter: (id) => {
      if (timer.current) clearTimeout(timer.current);
      setOpen(id);
    },
    leave: () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setOpen(null), 180);
    },
  };
  const count = (stage: BoardStage) => overview.workItems.filter((i) => boardStage(i) === stage).length;
  const running = (id: string) => (w ? lastRun(w, id).status === "running" : false);
  return (
    <div ref={ref} className="relative h-full min-h-0 overflow-hidden">
      <div className="absolute top-1/2 left-1/2" style={{ width: W, height: H, transform: `translate(-50%, -50%) scale(${scale})` }}>
        <Wires edges={edgesFor(w)} open={open} />
        <AgentWorkspace id="agent.compute" w={w} onStep={setSubtask} openEvidence={openEvidence} hover={hover} />
        <AgentWorkspace id="agent.finance" w={w} onStep={setSubtask} openEvidence={openEvidence} hover={hover} />
        <LedgerWorkspace w={w} hover={hover} />
        <NodePill id="intake" icon={<Inbox className="size-4 text-zinc-500" />} label={"Invoices · " + overview.metrics.lineCount} count={0} />
        <NodePill id="agent.compute" icon={<AgentAvatar actorId="agent.compute" size="sm" />} label={overview.actors["agent.compute"]?.name ?? "Compute Agent"} count={count("investigate")} live={running("agent.compute")} hover={hover} />
        <NodePill id="agent.finance" icon={<AgentAvatar actorId="agent.finance" size="sm" />} label={overview.actors["agent.finance"]?.name ?? "Finance Agent"} count={count("propose")} live={running("agent.finance")} hover={hover} />
        <NodePill id="ledger" icon={<BookCheck className="size-4 text-zinc-500" />} label="Ledger" count={count("done")} href="/audit" hover={hover} />
        <NodePill id="vendor" icon={<Building2 className="size-4 text-zinc-500" />} label="Vendor" count={count("vendor")} />
        <You overview={overview} w={w} />
      </div>
      {w && subtask ? <SubtaskDialog key={`${subtask.agentId}:${subtask.label}:${subtask.runId}`} selection={subtask} onClose={() => setSubtask(null)} /> : null}
    </div>
  );
}

type Items = DashboardData["workItems"];

/** Floating card in the top-right corner: which task the canvas shows, and where it stands. */
function TaskPanel({ items, id, onSelect, w }: { items: Items; id: string | undefined; onSelect: (id: string) => void; w?: WorkspaceData }) {
  const [collapsed, setCollapsed] = useState(false);
  const pending = w?.approvals.find((a) => a.status === "PENDING");
  const asking = w?.item.state === "NEEDS_INFO";
  const busy = w ? (["agent.compute", "agent.finance"] as const).map((a) => ({ a, r: lastRun(w, a) })).find((x) => x.r.status === "running" || x.r.queued) : undefined;
  return (
    <div className="card-soft absolute top-4 right-4 z-40 w-[320px] max-w-[calc(100%-2rem)] overflow-hidden">
      <div className="flex h-10 items-center gap-1 border-b bg-zinc-50/80 pr-1 pl-2">
        <select
          aria-label="Task shown on canvas"
          value={id ?? ""}
          onChange={(e) => onSelect(e.target.value)}
          disabled={!items.length}
          className="h-7 min-w-0 flex-1 truncate rounded-md bg-transparent px-1 font-mono text-[11.5px] text-zinc-700 outline-none hover:bg-zinc-100"
        >
          {!items.length && <option value="">No tasks this period</option>}
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.id} · {item.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand task" : "Collapse task"}
          className="grid size-7 place-items-center rounded-md text-zinc-500 hover:bg-zinc-100"
        >
          <ChevronDown className={cn("size-4 transition-transform", collapsed && "-rotate-90")} />
        </button>
      </div>
      {!collapsed && w ? (
        <div className="space-y-3 p-4">
          <div>
            <div className="text-[14px] leading-snug font-semibold">{w.item.title}</div>
            <div className="mt-1 flex items-center gap-2">
              <StateBadge state={w.item.state} />
            </div>
          </div>
          <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
            <dt className="text-muted-foreground">Provider</dt>
            <dd className="truncate text-zinc-800">{w.providers[w.item.providerId]?.name}</dd>
            <dt className="text-muted-foreground">Resource</dt>
            <dd className="truncate font-mono text-[11.5px] text-zinc-800">{w.item.instanceId ?? w.item.reservationId}</dd>
            <dt className="text-muted-foreground">Charge</dt>
            <dd className="text-zinc-800 tnum">{money(w.item.invoicedCents)}</dd>
          </dl>
          {busy ? (
            <div className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-[12px] ring-1 ring-zinc-200/70">
              <AgentAvatar actorId={busy.a} size="sm" />
              <span className="flex-1 truncate text-zinc-700">{w.actors[busy.a]?.name}</span>
              <span className="flex items-center gap-1 text-brand-ink">
                {busy.r.status === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                {busy.r.status === "running" ? (busy.r.current?.verb ?? "Working") : "Queued"}
              </span>
            </div>
          ) : null}
          {pending || asking ? (
            <div className="rounded-lg bg-accent px-3 py-2.5">
              <div className="text-[12.5px] font-medium text-brand-ink">{pending ? "Waiting on your approval" : "An agent has a question"}</div>
              {pending ? <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-zinc-700">{pending.summary}</p> : null}
              <Link
                href={"/investigations/" + w.item.id}
                className="mt-2 inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground hover:opacity-90"
              >
                Review <ArrowUpRight className="size-3.5" />
              </Link>
            </div>
          ) : (
            <Link href={"/investigations/" + w.item.id} className="inline-flex items-center gap-1 text-[12px] text-brand-ink hover:underline">
              Open task <ArrowUpRight className="size-3.5" />
            </Link>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ConnectedCanvas({ overview, id, items, onSelect }: { overview: DashboardData; id: string; items: Items; onSelect: (id: string) => void }) {
  const { data, mutate } = useSWR<WorkspaceData>(`/api/work-items/${id}`, fetcher, { keepPreviousData: true });
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  useLiveRefresh(() => mutate(), (event) => event.workItemId === id || event.workItemId === null, 150);
  const panel = <TaskPanel items={items} id={id} onSelect={onSelect} w={data} />;
  if (!data) {
    return (
      <>
        <Radial overview={overview} openEvidence={setEvidenceId} />
        {panel}
      </>
    );
  }
  return (
    <WorkspaceContext.Provider value={{ data, openEvidence: setEvidenceId, refresh: () => void mutate() }}>
      <Radial overview={overview} w={data} openEvidence={setEvidenceId} />
      {panel}
      <EvidenceDialog evidenceId={evidenceId} onClose={() => setEvidenceId(null)} />
    </WorkspaceContext.Provider>
  );
}

export function SystemCanvas({ data }: { data: DashboardData }) {
  const [selected, setSelected] = useState<string | null>(null);
  const items = data.workItems.filter((item) => item.period === data.period);
  const id = items.some((item) => item.id === selected)
    ? selected!
    : (items.find((item) => data.agents.some((a) => a.currentWorkItemId === item.id))?.id ?? items[0]?.id);
  return (
    <div className="bg-dots relative h-full min-h-0">
      <div className="h-full pt-6 pb-16 lg:pr-[336px]">
        {id ? (
          <ConnectedCanvas key={id} overview={data} id={id} items={items} onSelect={setSelected} />
        ) : (
          <>
            <Radial overview={data} openEvidence={() => {}} />
            <TaskPanel items={items} id={undefined} onSelect={setSelected} />
          </>
        )}
      </div>
    </div>
  );
}
