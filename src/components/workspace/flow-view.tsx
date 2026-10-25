"use client";

import { BookCheck, Building2, Calculator, CalendarRange, Check, FileText, FlaskConical, Gauge, History, ListTree, Receipt, ScrollText, Server, User, Wallet, type LucideIcon } from "lucide-react";
import { agentSteps, type StepState } from "@/lib/agent-steps";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { WorkspaceData } from "@/server/queries";
import { StatusPill, StepList } from "../agent-steps";
import { AgentAvatar } from "../status";
import { ReservationUsage } from "./reservation-usage";
import { UsageTimeline } from "./usage-timeline";
import { PROJECT_COLORS, useWorkspace } from "./workspace-context";

type Tone = "blue" | "orange" | "red" | "green" | "zinc";

function runFor(data: WorkspaceData, agentId: string) {
  const runs = data.runs.filter((r) => r.agentId === agentId);
  const run = runs[runs.length - 1];
  const tools = run ? data.activity.filter((e) => e.runId === run.id && e.toolName).map((e) => e.toolName!) : [];
  const status = run?.status === "running" || run?.status === "completed" || run?.status === "failed" ? run.status : "none";
  const queued = data.agents.some((a) => a.agentId === agentId && a.status === "queued" && a.currentWorkItemId === data.item.id);
  return { runs: runs.length, status, queued, ...agentSteps(agentId, tools, status) } as const;
}

/** What is happening on this item right now, in two or three words. */
export function flowStatus(data: WorkspaceData): { label: string; tone: Tone; spin: boolean } {
  for (const id of ["agent.compute", "agent.finance"]) {
    const r = runFor(data, id);
    if (r.status === "running") return { label: r.current?.verb ?? "Working", tone: "blue", spin: true };
  }
  if (data.agents.some((a) => a.currentWorkItemId === data.item.id && a.status === "queued")) return { label: "Queued", tone: "zinc", spin: false };
  switch (data.item.state) {
    case "NEEDS_APPROVAL":
      return { label: "Awaiting you", tone: "orange", spin: false };
    case "NEEDS_INFO":
      return { label: "Question for you", tone: "orange", spin: false };
    case "DISPUTED":
      return { label: "Waiting on vendor", tone: "red", spin: false };
    case "POSTED":
    case "RESOLVED":
      return { label: "Done", tone: "green", spin: false };
    case "APPROVED":
      return { label: "Posting", tone: "blue", spin: true };
    default:
      return { label: "Starting", tone: "blue", spin: true };
  }
}

function Connector({ active, tone = "blue" }: { active: boolean; tone?: "blue" | "orange" }) {
  return (
    <svg className="h-3 min-w-6 flex-1" preserveAspectRatio="none">
      <line
        x1="0"
        y1="6"
        x2="100%"
        y2="6"
        stroke={active ? (tone === "orange" ? "var(--primary)" : "var(--primary)") : "#d4d4d8"}
        strokeWidth={active ? 1.75 : 1.25}
        strokeDasharray={active ? undefined : "3 5"}
        className={active ? "flow-dash" : undefined}
      />
    </svg>
  );
}

function AgentCard({ data, agentId }: { data: WorkspaceData; agentId: string }) {
  const r = runFor(data, agentId);
  const active = r.status === "running";
  const idle = r.status === "none" && !r.queued;
  return (
    <div className={cn("card-soft w-[190px] shrink-0 p-3", active && "outline-2! outline-primary!", idle && "opacity-60")}>
      <div className="flex items-center gap-2">
        <AgentAvatar actorId={agentId} size="sm" />
        <span className="flex-1 truncate text-[13px] font-semibold">{data.actors[agentId]?.name}</span>
        {r.runs > 1 ? <span className="font-mono text-[10.5px] text-zinc-400">x{r.runs}</span> : null}
      </div>
      <StepList steps={r.steps} className="mt-2.5" />
    </div>
  );
}

function PillNode({ icon: Icon, label, state, sub }: { icon: LucideIcon; label: string; state: StepState | "waiting" | "skipped" | "alert"; sub?: string }) {
  return (
    <div
      className={cn(
        "card-soft flex shrink-0 flex-col items-center gap-1 px-4 py-3",
        state === "waiting" && "outline-2! outline-primary!",
        state === "alert" && "outline-destructive/30!",
        (state === "todo" || state === "skipped") && "opacity-50",
      )}
    >
      <span className="relative">
        <Icon className="size-5 text-zinc-600" />
        {state === "done" ? <Check className="absolute -right-2 -bottom-1 size-3.5 rounded-full bg-primary p-0.5 text-primary-foreground" /> : null}
        {state === "waiting" ? <span className="absolute -top-0.5 -right-1 size-2 animate-pulse rounded-full bg-primary" /> : null}
      </span>
      <span className="text-[12.5px] font-medium">{label}</span>
      {sub ? <span className="text-[10.5px] text-muted-foreground">{sub}</span> : null}
    </div>
  );
}

function FlowStrip({ data }: { data: WorkspaceData }) {
  const compute = runFor(data, "agent.compute");
  const finance = runFor(data, "agent.finance");
  const pending = data.approvals.some((a) => a.status === "PENDING");
  const decided = data.approvals.filter((a) => a.status !== "PENDING");
  const lastDecision = decided[decided.length - 1];
  const posted = data.journal.some((e) => e.source !== "erp_ap");
  const finished = data.item.state === "POSTED" || data.item.state === "RESOLVED" || data.item.state === "DISPUTED";
  const youState = pending || data.item.state === "NEEDS_INFO" ? "waiting" : lastDecision ? "done" : finished ? "skipped" : "todo";
  const youSub = pending ? "Your turn" : lastDecision ? (lastDecision.status === "APPROVED" ? "Approved" : "Sent back") : finished ? "Not needed" : undefined;
  return (
    <div className="flex items-center overflow-x-auto pt-1 pb-2">
      <AgentCard data={data} agentId="agent.compute" />
      <Connector active={finance.status === "running" || (compute.status === "completed" && finance.queued)} />
      <AgentCard data={data} agentId="agent.finance" />
      <Connector active={pending} tone="orange" />
      <PillNode icon={User} label="You" state={youState} sub={youSub} />
      <Connector active={data.item.state === "APPROVED"} />
      <PillNode icon={BookCheck} label="Ledger" state={posted ? "done" : "todo"} sub={posted ? "Posted" : undefined} />
      {data.dispute ? (
        <>
          <Connector active={false} />
          <PillNode
            icon={Building2}
            label="Vendor"
            state={data.dispute.status === "SUBMITTED" ? "alert" : "done"}
            sub={data.dispute.status === "SUBMITTED" ? "Disputed" : data.dispute.status === "CREDIT_ACCEPTED" ? "Credited" : "Denied"}
          />
        </>
      ) : null}
    </div>
  );
}

const SOURCES: { type: string; label: string; icon: LucideIcon; kind: "billing" | "allocation" | "both" | "finance" }[] = [
  { type: "invoice_line", label: "Invoice", icon: Receipt, kind: "both" },
  { type: "lifecycle", label: "Lifecycle", icon: Server, kind: "billing" },
  { type: "job_log", label: "Jobs", icon: ListTree, kind: "billing" },
  { type: "provider_usage", label: "Meter", icon: Gauge, kind: "billing" },
  { type: "reservation", label: "Reservation", icon: CalendarRange, kind: "allocation" },
  { type: "usage", label: "Usage", icon: Gauge, kind: "allocation" },
  { type: "experiment", label: "Experiments", icon: FlaskConical, kind: "both" },
  { type: "contract", label: "Contract", icon: FileText, kind: "both" },
  { type: "budget", label: "Budget", icon: Wallet, kind: "finance" },
  { type: "policy", label: "Policy", icon: ScrollText, kind: "finance" },
  { type: "precedent", label: "Precedents", icon: History, kind: "finance" },
  { type: "calculation", label: "Math", icon: Calculator, kind: "finance" },
];

function SourceTiles({ data }: { data: WorkspaceData }) {
  const { openEvidence } = useWorkspace();
  const billing = data.item.type === "BILLING_VARIANCE";
  const rows: { agentId: string; tiles: typeof SOURCES }[] = [
    { agentId: "agent.compute", tiles: SOURCES.filter((s) => s.kind === "both" || s.kind === (billing ? "billing" : "allocation")) },
    { agentId: "agent.finance", tiles: SOURCES.filter((s) => s.kind === "finance") },
  ];
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.agentId} className="flex items-center gap-2">
          <AgentAvatar actorId={row.agentId} size="sm" />
          <div className="flex flex-wrap gap-1.5">
            {row.tiles.map((t) => {
              const ev = data.evidence.find((e) => e.sourceType === t.type);
              return (
                <button
                  key={t.type}
                  type="button"
                  disabled={!ev}
                  onClick={() => ev && openEvidence(ev.id)}
                  title={ev ? ev.label : "Not gathered yet"}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] transition-all",
                    ev ? "bg-white text-zinc-700 shadow-xs ring-1 ring-zinc-200 hover:ring-zinc-400 animate-enter" : "text-zinc-300 ring-1 ring-zinc-200 ring-dashed",
                  )}
                >
                  <t.icon className="size-3.5" />
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ResultBar({ data }: { data: WorkspaceData }) {
  const proposal = data.proposals[data.proposals.length - 1];
  if (!proposal) return null;
  const total = proposal.payload.totalCents || 1;
  const dispute = proposal.payload.dispute;
  const segments = dispute
    ? [
        { key: "ok", label: "Supported", cents: dispute.undisputedCents, className: "bg-zinc-700" },
        { key: "bad", label: "Disputed", cents: dispute.disputedCents, className: "hatch-red ring-1 ring-destructive/30 ring-inset" },
      ]
    : proposal.payload.allocation.map((l) => ({
        key: l.projectId,
        label: data.projects[l.projectId]?.name ?? l.projectId,
        cents: l.amountCents,
        className: PROJECT_COLORS[l.projectId]?.bar ?? "bg-zinc-500",
      }));
  const sum = dispute ? dispute.invoicedCents : total;
  return (
    <div>
      <div className="flex h-7 overflow-hidden rounded-lg">
        {segments.map((s) => (
          <div key={s.key} className={cn("h-full transition-all duration-700", s.className)} style={{ width: (s.cents / sum) * 100 + "%" }} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        {segments.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5 text-[12px]">
            <span className={cn("size-2.5 rounded-sm", s.className)} />
            <span className="text-zinc-500">{s.label}</span>
            <span className={cn("font-medium tnum", s.key === "bad" ? "text-destructive" : "text-zinc-900")}>{money(s.cents, { cents: false })}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2.5 font-mono text-[10.5px] tracking-wider text-zinc-400 uppercase">{title}</div>
      {children}
    </div>
  );
}

export function FlowView() {
  const { data } = useWorkspace();
  const status = flowStatus(data);
  const proposal = data.proposals[data.proposals.length - 1];
  return (
    <div className="bg-canvas h-full overflow-y-auto">
      <div className="mx-auto max-w-[860px] space-y-8 px-6 py-6">
        <FlowStrip data={data} />
        <div className="relative pt-4">
          {status.tone === "orange" ? null : (
            <StatusPill label={status.label} tone={status.tone} spin={status.spin} className="absolute top-0 left-5 z-10" />
          )}
          <div className="card-soft space-y-6 p-5 pt-7">
            <Panel title="Gathered">
              <SourceTiles data={data} />
            </Panel>
            <Panel title={data.item.type === "BILLING_VARIANCE" ? "Billed vs ran" : "Reserved capacity"}>
              {data.item.type === "BILLING_VARIANCE" ? <UsageTimeline data={data} /> : <ReservationUsage data={data} />}
            </Panel>
            {proposal ? (
              <Panel title={(proposal.kind === "VENDOR_DISPUTE" ? "Dispute" : "Allocation") + " v" + proposal.version}>
                <ResultBar data={data} />
              </Panel>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
