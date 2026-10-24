"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { BookCheck, Gavel, LoaderCircle, MessageSquareText, ScrollText } from "lucide-react";
import { postJson } from "@/lib/api";
import { clockTime, dateOnly, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { WorkspaceData } from "@/server/queries";
import { AgentAvatar, AgentStatusPill } from "../status";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { AllocationTable, ApprovalCard, JournalPreview } from "./approval-card";
import { useWorkspace } from "./workspace-context";

const AGENTS = [
  { id: "agent.compute", role: "Investigates GPU jobs, instance lifecycles, provider meters, reservations, and billing terms." },
  { id: "agent.finance", role: "Applies accounting policy, prepares allocations and disputes, and proposes adjustments." },
];

const OUTCOME_LABEL: Record<string, string> = {
  CHARGE_EXPLAINED: "Charge explained and allocated under standing policy",
  ALLOCATED_UNDER_POLICY: "Allocated automatically under an approved policy",
  ALLOCATED_WITH_APPROVAL: "Allocated with controller approval",
  CHARGE_ALLOCATED: "Allocated with controller approval",
  DISPUTE_SUBMITTED: "Dispute submitted to vendor",
  VENDOR_CREDIT: "Vendor issued a credit",
  CHARGE_UPHELD: "Vendor denied the dispute; charge upheld",
};

const PROPOSAL_TONE: Record<string, string> = {
  DRAFT: "bg-zinc-100 text-zinc-600",
  PENDING_APPROVAL: "bg-orange-100 text-orange-700",
  APPROVED: "bg-teal-100 text-teal-700",
  EXECUTED: "bg-emerald-100 text-emerald-700",
  REJECTED: "bg-rose-100 text-rose-700",
  CHANGES_REQUESTED: "bg-amber-100 text-amber-800",
  SUPERSEDED: "bg-zinc-100 text-zinc-500",
  PROPOSED: "bg-orange-100 text-orange-700",
};

function AgentCard({ agentId, role, data }: { agentId: string; role: string; data: WorkspaceData }) {
  const status = data.agents.find((a) => a.agentId === agentId);
  const here = status?.currentWorkItemId === data.item.id;
  const runs = data.runs.filter((r) => r.agentId === agentId);
  const lastFinding = [...data.activity].reverse().find((e) => e.actorId === agentId && ["FINDING", "PROPOSAL", "POLICY", "HANDOFF"].includes(e.type));
  const toolCalls = data.activity.filter((e) => e.actorId === agentId && e.toolName).length;
  const shownStatus = here ? status?.status ?? "idle" : "idle";
  return (
    <div className={cn("rounded-xl border bg-white p-3", here && shownStatus === "working" && "ring-2 ring-blue-200")}>
      <div className="flex items-center gap-2.5">
        <AgentAvatar actorId={agentId} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{data.actors[agentId]?.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{data.actors[agentId]?.title}</div>
        </div>
        <AgentStatusPill status={shownStatus} />
      </div>
      <p className="mt-2 text-[11.5px] leading-snug text-muted-foreground">{role}</p>
      {here && status?.currentTask ? (
        <div className="mt-2 rounded-md bg-blue-50 px-2.5 py-1.5 text-[11.5px] text-blue-800">
          <span className="font-medium">Current task:</span> {status.currentTask}
        </div>
      ) : null}
      {lastFinding ? (
        <div className="mt-2 rounded-md bg-zinc-50 px-2.5 py-1.5">
          <div className="text-[11.5px] font-medium text-zinc-800">{lastFinding.title}</div>
          {lastFinding.summary ? <div className="mt-0.5 line-clamp-3 text-[11.5px] leading-snug text-zinc-600">{lastFinding.summary}</div> : null}
        </div>
      ) : (
        <div className="mt-2 text-[11.5px] text-muted-foreground">No findings on this item yet.</div>
      )}
      <div className="mt-2 text-[10.5px] text-muted-foreground tnum">
        {runs.length} run(s) · {toolCalls} tool calls on {data.item.id}
      </div>
    </div>
  );
}

function InfoCard({ data }: { data: WorkspaceData }) {
  const { refresh } = useWorkspace();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const q = data.item.pendingQuestion;
  if (data.item.state !== "NEEDS_INFO" || !q) return null;
  const send = async () => {
    setBusy(true);
    try {
      await postJson("/api/work-items/" + data.item.id + "/info", { answer });
      toast.success("Sent. The agent resumes with your input.");
      setAnswer("");
      refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-xl border border-amber-200 bg-white">
      <div className="flex items-center gap-2 border-b border-amber-100 bg-amber-50/70 px-3 py-2 text-[12px] font-semibold text-amber-900">
        <MessageSquareText className="size-4" /> Information requested
      </div>
      <div className="space-y-2 p-3">
        <p className="text-[12px] leading-snug text-zinc-800">{q.question}</p>
        <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" className="min-h-[64px] text-[12.5px]" />
        <Button size="sm" onClick={send} disabled={busy || answer.trim().length < 3}>
          {busy ? <LoaderCircle className="animate-spin" /> : null} Send and resume
        </Button>
      </div>
    </div>
  );
}

function OutcomeCard({ data }: { data: WorkspaceData }) {
  const { refresh } = useWorkspace();
  const [busy, setBusy] = useState<string | null>(null);
  const dispute = data.dispute;
  const respond = async (outcome: "accept" | "deny") => {
    setBusy(outcome);
    try {
      await postJson("/api/work-items/" + data.item.id + "/vendor-response", { outcome });
      toast.success(outcome === "accept" ? "Vendor credit recorded. Liability reduced." : "Dispute denied. Charge allocated to the owner.");
      refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!data.item.outcome && !dispute && data.journal.length <= 1) return null;
  return (
    <div className="rounded-xl border bg-white">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-[12px] font-semibold">
        <BookCheck className="size-4 text-emerald-600" /> Outcome and postings
      </div>
      <div className="space-y-3 p-3">
        {data.item.outcome ? <div className="text-[12.5px] font-medium text-zinc-900">{OUTCOME_LABEL[data.item.outcome] ?? data.item.outcome}</div> : null}
        {dispute ? (
          <div className="rounded-lg bg-rose-50/60 p-2.5 ring-1 ring-rose-100">
            <div className="flex items-center gap-2 text-[12px]">
              <Gavel className="size-3.5 text-rose-600" />
              <span className="font-medium">{dispute.id}</span>
              <span className="text-muted-foreground">{money(dispute.amountCents)}</span>
              <span className="ml-auto rounded bg-white px-1.5 py-0.5 text-[10.5px] font-medium text-rose-700">{dispute.status}</span>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              Vendor reference {dispute.vendorReference} · submitted {clockTime(dispute.submittedAt)}
            </div>
            <div className="mt-2 text-[11.5px] text-zinc-700">
              Accounts payable for this line: <span className="font-semibold tnum">{money(data.apOutstandingCents)}</span>
              {dispute.status === "SUBMITTED" ? " (unchanged until the vendor credits it)" : ""}
            </div>
            {dispute.status === "SUBMITTED" ? (
              <div className="mt-2.5">
                <div className="mb-1.5 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">Simulated vendor response</div>
                <div className="flex gap-1.5">
                  <Button size="xs" variant="outline" onClick={() => respond("accept")} disabled={busy !== null}>
                    {busy === "accept" ? <LoaderCircle className="animate-spin" /> : null} Vendor issues credit
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => respond("deny")} disabled={busy !== null}>
                    {busy === "deny" ? <LoaderCircle className="animate-spin" /> : null} Vendor denies
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="space-y-1.5">
          {data.journal.map((entry) => (
            <details key={entry.id} className="rounded-md border px-2.5 py-1.5">
              <summary className="flex cursor-pointer items-center gap-2 text-[11.5px]">
                <span className="font-mono text-zinc-500">{entry.id}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-800">{entry.memo}</span>
                <span className="font-medium tnum">{money(entry.totalCents)}</span>
              </summary>
              <div className="space-y-1.5 pt-1.5">
                <div className="text-[10.5px] text-muted-foreground">
                  {entry.source === "erp_ap" ? "ERP AP subledger (simulated)" : "Ledger gateway"} · {entry.authorization}
                </div>
                <JournalPreview lines={entry.lines} projects={data.projects} />
              </div>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProposalHistory({ data }: { data: WorkspaceData }) {
  if (!data.proposals.length) return null;
  return (
    <div className="rounded-xl border bg-white">
      <div className="border-b px-3 py-2 text-[12px] font-semibold">Proposal history</div>
      <ol className="divide-y">
        {[...data.proposals].reverse().map((p) => {
          const decision = data.approvals.find((a) => a.subjectId === p.id && a.status !== "PENDING");
          return (
            <li key={p.id} className="space-y-1.5 p-3">
              <div className="flex items-center gap-2 text-[12px]">
                <span className="font-medium">
                  {p.id} v{p.version}
                </span>
                <span className="text-muted-foreground">{p.kind === "VENDOR_DISPUTE" ? "Vendor dispute" : "Allocation"}</span>
                <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium", PROPOSAL_TONE[p.status])}>{p.status}</span>
              </div>
              <AllocationTable proposal={p} projects={data.projects} />
              {decision?.decisionReason ? (
                <div className="rounded-md bg-zinc-50 px-2.5 py-1.5 text-[11.5px] text-zinc-700">
                  <span className="font-medium">{data.actors[decision.decidedBy ?? ""]?.name}:</span> {decision.decisionReason}
                </div>
              ) : null}
              {p.authorization ? <div className="text-[10.5px] text-muted-foreground">Authorization: {p.authorization}</div> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function PolicyList({ data }: { data: WorkspaceData }) {
  const relevant = data.policies.filter((p) => data.item.type === "SHARED_ALLOCATION" || p.learnedFromWorkItemId === data.item.id);
  if (!relevant.length) return null;
  return (
    <div className="rounded-xl border bg-white">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-[12px] font-semibold">
        <ScrollText className="size-4 text-indigo-600" /> Allocation policy versions
      </div>
      <ol className="divide-y">
        {[...relevant].reverse().map((p) => (
          <li key={p.id} className="p-3">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="font-medium">
                {p.policyKey} v{p.version}
              </span>
              <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium", PROPOSAL_TONE[p.status] ?? "bg-zinc-100 text-zinc-600")}>{p.status}</span>
            </div>
            <p className="mt-1 text-[11.5px] leading-snug text-zinc-700">{p.statement}</p>
            <div className="mt-1 text-[10.5px] text-muted-foreground">
              {p.approvedBy ? "Approved by " + (data.actors[p.approvedBy]?.name ?? p.approvedBy) + " " + dateOnly(p.approvedAt) : "Proposed by " + (data.actors[p.proposedBy]?.name ?? p.proposedBy)}
              {p.learnedFromWorkItemId ? (
                <>
                  {" "}
                  · learned from{" "}
                  <Link className="text-blue-700 hover:underline" href={"/investigations/" + p.learnedFromWorkItemId}>
                    {p.learnedFromWorkItemId}
                  </Link>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function TeamPanel() {
  const { data } = useWorkspace();
  const pending = data.approvals.filter((a) => a.status === "PENDING");
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold">Agent team and decisions</h2>
        {pending.length ? <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">{pending.length} pending</span> : null}
      </div>
      {pending.map((a) => (
        <ApprovalCard key={a.id} approval={a} />
      ))}
      <InfoCard data={data} />
      <OutcomeCard data={data} />
      {AGENTS.map((a) => (
        <AgentCard key={a.id} agentId={a.id} role={a.role} data={data} />
      ))}
      <ProposalHistory data={data} />
      <PolicyList data={data} />
    </div>
  );
}
