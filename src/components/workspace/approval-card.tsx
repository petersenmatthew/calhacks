"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, LoaderCircle, TriangleAlert, Undo2, X } from "lucide-react";
import { postJson } from "@/lib/api";
import { money, relativeTime } from "@/lib/format";
import { useNow } from "@/lib/use-now";
import type { WorkspaceData } from "@/server/queries";
import { AgentAvatar } from "../status";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { EvidenceChips } from "./evidence-dialog";
import { ACCOUNT_NAMES, PROJECT_COLORS, useWorkspace } from "./workspace-context";

type Approval = WorkspaceData["approvals"][number];
type Proposal = WorkspaceData["proposals"][number];

const METHOD_LABEL: Record<string, string> = {
  usage_proportional: "Proportional to GPU-hours used",
  owner_pays_idle: "Usage to each team; idle capacity to the reservation owner",
  owner_pays_all: "Entire reservation to the owner",
  single_owner: "Full charge to the owning project",
  undisputed_to_owner: "Contract-supported amount to the owning project",
};

export function JournalPreview({ lines, projects }: { lines: Proposal["payload"]["journalPreview"]; projects: WorkspaceData["projects"] }) {
  const debits = lines.reduce((s, l) => s + l.debitCents, 0);
  const credits = lines.reduce((s, l) => s + l.creditCents, 0);
  return (
    <table className="w-full text-[11px]">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="py-1 font-medium">Account</th>
          <th className="py-1 text-right font-medium">Debit</th>
          <th className="py-1 text-right font-medium">Credit</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={i} className="border-t">
            <td className="py-1">
              <span className="font-mono text-zinc-500">{l.accountCode}</span> {ACCOUNT_NAMES[l.accountCode] ?? ""}
              {l.projectId ? <span className="text-muted-foreground"> · {projects[l.projectId]?.name ?? l.projectId}</span> : null}
            </td>
            <td className="py-1 text-right tnum">{l.debitCents ? money(l.debitCents) : ""}</td>
            <td className="py-1 text-right tnum">{l.creditCents ? money(l.creditCents) : ""}</td>
          </tr>
        ))}
        <tr className="border-t font-medium">
          <td className="py-1 text-emerald-700">{debits === credits ? "Balanced" : "Unbalanced"}</td>
          <td className="py-1 text-right tnum">{money(debits)}</td>
          <td className="py-1 text-right tnum">{money(credits)}</td>
        </tr>
      </tbody>
    </table>
  );
}

export function AllocationTable({ proposal, projects }: { proposal: Proposal; projects: WorkspaceData["projects"] }) {
  const total = proposal.payload.totalCents || 1;
  return (
    <div className="space-y-1">
      {proposal.payload.allocation.map((l) => (
        <div key={l.projectId} className="flex items-center gap-2 text-[12px]">
          <span className={"size-2 rounded-sm " + (PROJECT_COLORS[l.projectId]?.dot ?? "bg-zinc-400")} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-zinc-800">{projects[l.projectId]?.name ?? l.projectId}</span>
            <span className="block truncate text-[10.5px] text-muted-foreground">{l.basis}</span>
          </span>
          <span className="text-[10.5px] text-muted-foreground tnum">{((l.amountCents / total) * 100).toFixed(1)}%</span>
          <span className="w-[86px] text-right font-medium tnum">{money(l.amountCents)}</span>
        </div>
      ))}
      <div className="flex justify-between border-t pt-1 text-[12px] font-medium">
        <span>Total</span>
        <span className="tnum">{money(proposal.payload.totalCents)}</span>
      </div>
    </div>
  );
}

export function ApprovalCard({ approval }: { approval: Approval }) {
  const { data, refresh } = useWorkspace();
  const now = useNow();
  const [reason, setReason] = useState("");
  const [directive, setDirective] = useState<string>("none");
  const [busy, setBusy] = useState<string | null>(null);
  const proposal = approval.subjectType === "PROPOSAL" ? data.proposals.find((p) => p.id === approval.subjectId) : undefined;
  const policy = approval.subjectType === "POLICY" ? data.policies.find((p) => p.id === approval.subjectId) : undefined;
  const isAllocation = proposal?.kind === "ALLOCATION" && data.item.type === "SHARED_ALLOCATION";
  const currentPolicy = data.policyFit?.policy ?? null;
  const deviatesFromPolicy = Boolean(isAllocation && currentPolicy && proposal && currentPolicy.rule.method !== proposal.method);
  const pendingPolicy = data.policies.find((p) => p.status === "PROPOSED" && proposal && p.rule.method === proposal.method);

  const decide = async (decision: "APPROVED" | "REJECTED" | "CHANGES_REQUESTED") => {
    if (decision !== "APPROVED" && reason.trim().length < 3) {
      toast.error("Add a reason so the agents can rework the proposal.");
      return;
    }
    setBusy(decision);
    try {
      await postJson("/api/approvals/" + approval.id, {
        decision,
        reason: reason.trim() || null,
        directive: directive === "none" ? null : directive,
      });
      toast.success(decision === "APPROVED" ? "Approved. The ledger gateway executes it." : "Sent back to the Finance Agent with your reason.");
      refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  let title = approval.subjectId;
  if (proposal?.kind === "VENDOR_DISPUTE") title = "Dispute " + money(proposal.payload.dispute?.disputedCents ?? 0) + " with " + data.providers[data.item.providerId]?.name + "?";
  else if (proposal) title = "Post allocation of " + money(proposal.payload.totalCents) + "?";
  else if (policy) title = "Adopt policy " + policy.policyKey + " v" + policy.version + "?";

  return (
    <div className="max-w-3xl space-y-3 px-6 py-4 animate-enter">
      <div>
        <div className="text-[14px] font-semibold">{title}</div>
        <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <AgentAvatar actorId={approval.requestedBy} size="sm" />
          {data.actors[approval.requestedBy]?.name} asked {relativeTime(approval.createdAt, now)}
          <span className="font-mono">· {approval.id}</span>
        </div>
        {proposal?.kind === "VENDOR_DISPUTE" ? null : <p className="mt-2 text-[12.5px] leading-snug text-zinc-700">{approval.summary}</p>}
      </div>

      {proposal?.kind === "VENDOR_DISPUTE" && proposal.payload.dispute ? (
        <div className="flex gap-8 text-[12px]">
          <div>
            <div className="text-muted-foreground">Invoiced</div>
            <div className="text-[14px] font-semibold tnum">{money(proposal.payload.dispute.invoicedCents)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Supported</div>
            <div className="text-[14px] font-semibold tnum">{money(proposal.payload.dispute.undisputedCents)}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Disputed</div>
            <div className="text-[14px] font-semibold text-rose-600 tnum">{money(proposal.payload.dispute.disputedCents)}</div>
          </div>
        </div>
      ) : null}

      {proposal && proposal.kind !== "VENDOR_DISPUTE" ? (
        <div className="max-w-xl space-y-1.5">
          <div className="text-[11.5px] text-muted-foreground">{METHOD_LABEL[proposal.method] ?? proposal.method}</div>
          <AllocationTable proposal={proposal} projects={data.projects} />
        </div>
      ) : null}

      {deviatesFromPolicy && currentPolicy ? (
        <p className="text-[12px] leading-snug text-sky-800">
          Differs from {currentPolicy.policyKey} v{currentPolicy.version} ({METHOD_LABEL[currentPolicy.rule.method] ?? currentPolicy.rule.method}) and follows the
          reservation terms.
          {pendingPolicy ? " " + pendingPolicy.policyKey + " v" + pendingPolicy.version + " is proposed so future cases use this method." : ""}
        </p>
      ) : proposal?.payload.policyFit && !proposal.payload.policyFit.consistent && !proposal.payload.policyFit.conflicts.every((c) => approval.summary.includes(c)) ? (
        <p className="flex gap-1.5 text-[12px] leading-snug text-amber-800">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          {proposal.payload.policyFit.conflicts.join(" ")}
        </p>
      ) : null}


      {policy ? (
        <div className="space-y-1.5">
          <p className="text-[12.5px] leading-snug text-zinc-800">{policy.statement}</p>
          <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-zinc-700">
            {policy.rule.conditions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="text-[11.5px] text-muted-foreground">
            Auto-posts up to {money(policy.rule.autoPostLimitCents, { cents: false })} · replaces {policy.supersedesId ?? "nothing"}
          </div>
        </div>
      ) : null}

      {proposal ? (
        <details className="group text-[12px]">
          <summary className="cursor-pointer list-none text-muted-foreground hover:text-zinc-900">
            <span className="group-open:hidden">Show journal entry, rationale, and evidence</span>
            <span className="hidden group-open:inline">Hide details</span>
          </summary>
          <div className="mt-2 max-w-xl space-y-3">
            <JournalPreview lines={proposal.payload.journalPreview} projects={data.projects} />
            <p className="leading-snug text-zinc-700">{proposal.rationale}</p>
            <EvidenceChips ids={proposal.evidenceIds} max={12} />
          </div>
        </details>
      ) : null}

      <div className="sticky bottom-0 space-y-2 bg-white pt-1 pb-1">
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (required to reject or request changes)"
          className="min-h-[40px] text-[12.5px]"
          rows={1}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            onClick={() => decide("APPROVED")}
            disabled={busy !== null}
            title={proposal?.kind === "VENDOR_DISPUTE" ? "Submits the dispute and posts only the supported amount. Payables stay at the full invoice until the vendor credits it." : undefined}
          >
            {busy === "APPROVED" ? <LoaderCircle className="animate-spin" /> : <Check />} Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => decide("CHANGES_REQUESTED")} disabled={busy !== null}>
            {busy === "CHANGES_REQUESTED" ? <LoaderCircle className="animate-spin" /> : <Undo2 />} Request changes
          </Button>
          <Button size="sm" variant="ghost" className="text-rose-600 hover:text-rose-700" onClick={() => decide("REJECTED")} disabled={busy !== null}>
            {busy === "REJECTED" ? <LoaderCircle className="animate-spin" /> : <X />} Reject
          </Button>
          {isAllocation ? (
            <Select value={directive} onValueChange={setDirective}>
              <SelectTrigger size="sm" className="ml-auto w-[280px] text-[12px]">
                <SelectValue placeholder="Corrected allocation basis (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No structured correction</SelectItem>
                <SelectItem value="owner_pays_idle">Idle reserved capacity to the reservation owner</SelectItem>
                <SelectItem value="usage_proportional">Proportional to GPU-hours used</SelectItem>
                <SelectItem value="owner_pays_all">Entire reservation to the owner</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </div>
    </div>
  );
}
