"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Check, LoaderCircle, ShieldAlert, TriangleAlert, Undo2, X } from "lucide-react";
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
      toast.success(
        decision === "APPROVED"
          ? "Approved. The workflow resumes and the ledger gateway executes it."
          : "Sent back to the Finance Agent with your rationale.",
      );
      refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  let title = approval.subjectId;
  if (proposal?.kind === "VENDOR_DISPUTE") title = "Vendor dispute: " + money(proposal.payload.dispute?.disputedCents ?? 0) + " with " + data.providers[data.item.providerId]?.name;
  else if (proposal) title = "Allocation " + proposal.id + " v" + proposal.version + ": " + money(proposal.payload.totalCents);
  else if (policy) title = "New policy: " + policy.policyKey + " v" + policy.version;

  return (
    <div className="overflow-hidden rounded-xl border border-orange-200 bg-white shadow-xs animate-enter">
      <div className="flex items-center gap-2 border-b border-orange-100 bg-orange-50/70 px-3 py-2">
        <ShieldAlert className="size-4 text-orange-600" />
        <span className="text-[12px] font-semibold text-orange-800">Controller approval required</span>
        <span className="ml-auto font-mono text-[10.5px] text-orange-700/70">{approval.id}</span>
      </div>
      <div className="space-y-3 p-3">
        <div>
          <div className="text-[13px] font-semibold">{title}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <AgentAvatar actorId={approval.requestedBy} size="sm" />
            Requested by {data.actors[approval.requestedBy]?.name} · {relativeTime(approval.createdAt, now)}
          </div>
          <p className="mt-2 text-[12px] leading-snug text-zinc-700">{approval.summary}</p>
        </div>

        {proposal?.kind === "VENDOR_DISPUTE" && proposal.payload.dispute ? (
          <div className="grid grid-cols-3 rounded-lg bg-zinc-50 p-2 text-center text-[11px]">
            <div>
              <div className="text-muted-foreground">Invoiced</div>
              <div className="font-semibold tnum">{money(proposal.payload.dispute.invoicedCents)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Supported</div>
              <div className="font-semibold tnum">{money(proposal.payload.dispute.undisputedCents)}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Disputed</div>
              <div className="font-semibold text-rose-600 tnum">{money(proposal.payload.dispute.disputedCents)}</div>
            </div>
          </div>
        ) : null}

        {proposal ? (
          <div className="space-y-2">
            <div className="text-[11px] font-medium text-muted-foreground">{METHOD_LABEL[proposal.method] ?? proposal.method}</div>
            <AllocationTable proposal={proposal} projects={data.projects} />
            {deviatesFromPolicy && currentPolicy ? (
              <div className="rounded-md bg-sky-50 px-2.5 py-2 text-[11.5px] leading-snug text-sky-900">
                Deviates from {currentPolicy.policyKey} v{currentPolicy.version} ({METHOD_LABEL[currentPolicy.rule.method] ?? currentPolicy.rule.method}) and follows
                the reservation terms.
                {pendingPolicy ? " " + pendingPolicy.policyKey + " v" + pendingPolicy.version + " is proposed so future cases use this method." : ""}
              </div>
            ) : proposal.payload.policyFit && !proposal.payload.policyFit.consistent ? (
              <div className="flex gap-2 rounded-md bg-amber-50 px-2.5 py-2 text-[11.5px] leading-snug text-amber-900">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                <span>{proposal.payload.policyFit.conflicts.join(" ")}</span>
              </div>
            ) : null}
            {proposal.kind === "VENDOR_DISPUTE" ? (
              <p className="text-[11px] leading-snug text-muted-foreground">
                On approval the ledger gateway submits the dispute and posts only the supported amount. Accounts payable stays at the full invoice
                until the vendor issues a credit.
              </p>
            ) : null}
            <details className="rounded-md border px-2.5 py-1.5">
              <summary className="cursor-pointer text-[11.5px] font-medium text-zinc-700">Journal entry preview</summary>
              <div className="pt-1.5">
                <JournalPreview lines={proposal.payload.journalPreview} projects={data.projects} />
              </div>
            </details>
            <details className="rounded-md border px-2.5 py-1.5">
              <summary className="cursor-pointer text-[11.5px] font-medium text-zinc-700">Agent rationale and evidence</summary>
              <p className="pt-1.5 text-[11.5px] leading-snug text-zinc-700">{proposal.rationale}</p>
              <div className="pt-1.5">
                <EvidenceChips ids={proposal.evidenceIds} max={12} />
              </div>
            </details>
          </div>
        ) : null}

        {policy ? (
          <div className="space-y-2 rounded-lg bg-indigo-50/50 p-2.5 ring-1 ring-indigo-100">
            <p className="text-[12px] leading-snug text-zinc-800">{policy.statement}</p>
            <ul className="list-disc space-y-0.5 pl-4 text-[11.5px] text-zinc-700">
              {policy.rule.conditions.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="text-[11px] text-muted-foreground">
              Auto-post limit {money(policy.rule.autoPostLimitCents, { cents: false })} · supersedes {policy.supersedesId ?? "nothing"} · learned from{" "}
              {policy.learnedFromWorkItemId} · precedents {policy.precedentIds.join(", ") || "none"}
            </div>
          </div>
        ) : null}

        <div className="space-y-2">
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason or additional context (required to reject or request changes)"
            className="min-h-[64px] text-[12.5px]"
          />
          {isAllocation ? (
            <Select value={directive} onValueChange={setDirective}>
              <SelectTrigger className="w-full text-[12px]">
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
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => decide("APPROVED")} disabled={busy !== null}>
              {busy === "APPROVED" ? <LoaderCircle className="animate-spin" /> : <Check />} Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => decide("CHANGES_REQUESTED")} disabled={busy !== null}>
              {busy === "CHANGES_REQUESTED" ? <LoaderCircle className="animate-spin" /> : <Undo2 />} Request changes
            </Button>
            <Button size="sm" variant="destructive" onClick={() => decide("REJECTED")} disabled={busy !== null}>
              {busy === "REJECTED" ? <LoaderCircle className="animate-spin" /> : <X />} Reject
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
