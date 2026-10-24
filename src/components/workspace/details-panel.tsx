"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ChevronRight, FileSearch, LoaderCircle } from "lucide-react";
import { postJson } from "@/lib/api";
import { clockTime, dateOnly, dateTimeUtc, hours, money, periodLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InstanceChecks, ReservationChecks } from "@/server/db/schema";
import type { WorkspaceData } from "@/server/queries";
import { AgentAvatar, PRIORITY_LABEL } from "../status";
import { Button } from "../ui/button";
import { AllocationTable, JournalPreview } from "./approval-card";
import { SIMULATED_SOURCES, useWorkspace } from "./workspace-context";

const OUTCOME_LABEL: Record<string, string> = {
  CHARGE_EXPLAINED: "Charge explained and allocated under standing policy",
  ALLOCATED_UNDER_POLICY: "Allocated automatically under an approved policy",
  ALLOCATED_WITH_APPROVAL: "Allocated with controller approval",
  CHARGE_ALLOCATED: "Allocated with controller approval",
  DISPUTE_SUBMITTED: "Dispute submitted to vendor",
  VENDOR_CREDIT: "Vendor issued a credit",
  CHARGE_UPHELD: "Vendor denied the dispute; charge upheld",
};

const STATUS_TEXT: Record<string, string> = {
  PENDING_APPROVAL: "text-brand-ink",
  PROPOSED: "text-brand-ink",
  APPROVED: "text-brand-ink",
  EXECUTED: "text-brand-ink",
  REJECTED: "text-destructive",
  CHANGES_REQUESTED: "text-brand-ink",
};

function Section({ title, count, defaultOpen = false, children }: { title: string; count?: number; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t">
      <button type="button" onClick={() => setOpen(!open)} className="flex h-9 w-full items-center gap-1.5 px-4 text-left hover:bg-zinc-100/70">
        <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="flex-1 text-[12.5px] font-medium text-zinc-700">{title}</span>
        {count !== undefined ? <span className="text-[11.5px] text-muted-foreground tnum">{count}</span> : null}
      </button>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </div>
  );
}

function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words text-zinc-800">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function SourceButton({ sourceType, sourceId }: { sourceType: string; sourceId: string }) {
  const { data, openEvidence } = useWorkspace();
  const ev = data.evidence.find((e) => e.sourceType === sourceType && e.sourceId === sourceId);
  if (!ev) return null;
  return (
    <button type="button" onClick={() => openEvidence(ev.id)} className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-brand-ink hover:underline">
      <FileSearch className="size-3.5" /> View source record
    </button>
  );
}

function Properties({ data }: { data: WorkspaceData }) {
  const item = data.item;
  const agentId = item.state !== "RESOLVED" ? item.assignedAgentId : null;
  return (
    <div className="px-4 py-4">
      <KV
        rows={[
          [
            "Agent",
            agentId ? (
              <span key="a" className="flex items-center gap-1.5">
                <AgentAvatar actorId={agentId} size="sm" />
                <span className="truncate">{data.actors[agentId]?.name}</span>
              </span>
            ) : (
              <span key="a" className="text-muted-foreground">None</span>
            ),
          ],
          ["Priority", PRIORITY_LABEL[item.priority]],
          ["Type", item.type === "BILLING_VARIANCE" ? "Billing variance" : "Shared allocation"],
          ["Provider", data.providers[item.providerId]?.name],
          ["Resource", <span key="r" className="font-mono text-[11.5px]">{item.instanceId ?? item.reservationId}</span>],
          ["Period", periodLabel(item.period)],
        ]}
      />
    </div>
  );
}

function Numbers({ data }: { data: WorkspaceData }) {
  const item = data.item;
  if (item.type === "BILLING_VARIANCE") {
    const inst = item.checks as InstanceChecks;
    const over = item.discrepancyCents >= 100;
    return (
      <div className="border-t px-4 py-4">
        <KV
          rows={[
            ["Invoiced", <span key="i" className="tnum">{money(item.invoicedCents)} <span className="text-muted-foreground">({inst.billedHours} h x {money(inst.invoicedRateCents)})</span></span>],
            ["Expected", <span key="e" className="tnum">{money(item.expectedCents)} <span className="text-muted-foreground">({inst.billableHours} h x {money(inst.contractRateCents)})</span></span>],
            [
              "Difference",
              <span key="d" className={cn("font-medium tnum", over ? "text-destructive" : "text-brand-ink")}>
                {money(item.discrepancyCents, { sign: true })}
                <span className="font-normal text-muted-foreground"> {over ? "· " + hours(inst.billedHours - inst.billableHours) + " not supported" : "· matches contract"}</span>
              </span>,
            ],
          ]}
        />
      </div>
    );
  }
  const resv = item.checks as ReservationChecks;
  return (
    <div className="border-t px-4 py-4">
      <KV
        rows={[
          ["Charge", <span key="c" className="tnum">{money(item.invoicedCents)}</span>],
          ["Committed", <span key="m" className="tnum">{money(item.expectedCents)}</span>],
          ["To allocate", resv.usageByProject.length + " teams"],
        ]}
      />
    </div>
  );
}

function Outcome({ data }: { data: WorkspaceData }) {
  const { refresh } = useWorkspace();
  const [busy, setBusy] = useState<string | null>(null);
  const dispute = data.dispute;
  if (!data.item.outcome && !dispute && data.journal.length <= 1) return null;
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
  return (
    <div className="border-t px-4 py-4">
      <div className="text-[12px] font-medium text-zinc-500">Outcome</div>
      {data.item.outcome ? <div className="text-[13px] font-medium text-zinc-900">{OUTCOME_LABEL[data.item.outcome] ?? data.item.outcome}</div> : null}
      {dispute ? (
        <div className="space-y-2">
          <KV
            rows={[
              ["Dispute", <span key="d" className="tnum">{dispute.id} · {money(dispute.amountCents)} · <span className="text-destructive">{dispute.status.toLowerCase()}</span></span>],
              ["Vendor ref", dispute.vendorReference],
              ["Owed (AP)", <span key="ap" className="tnum">{money(data.apOutstandingCents)}{dispute.status === "SUBMITTED" ? " until credited" : ""}</span>],
            ]}
          />
          {dispute.status === "SUBMITTED" ? (
            <div className="flex items-center gap-1.5 pt-1">
              <span className="mr-1 text-[11.5px] text-muted-foreground">Simulate vendor:</span>
              <Button size="xs" variant="outline" onClick={() => respond("accept")} disabled={busy !== null}>
                {busy === "accept" ? <LoaderCircle className="animate-spin" /> : null} Issues credit
              </Button>
              <Button size="xs" variant="outline" onClick={() => respond("deny")} disabled={busy !== null}>
                {busy === "deny" ? <LoaderCircle className="animate-spin" /> : null} Denies
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {data.journal.length ? (
        <div className="space-y-1">
          {data.journal.map((entry) => (
            <details key={entry.id} className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-[12px]">
                <ChevronRight className="size-3 text-muted-foreground transition-transform group-open:rotate-90" />
                <span className="font-mono text-[11px] text-zinc-500">{entry.id}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-700">{entry.memo}</span>
                <span className="tnum">{money(entry.totalCents)}</span>
              </summary>
              <div className="space-y-1 py-2 pl-5">
                <div className="text-[11px] text-muted-foreground">{entry.authorization}</div>
                <JournalPreview lines={entry.lines} projects={data.projects} />
              </div>
            </details>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function DetailsPanel() {
  const { data, openEvidence } = useWorkspace();
  const { item, line, invoice, contract } = data;
  const cited = new Set<string>();
  for (const f of data.findings) for (const c of ((f.data as { clause_refs?: string[] }).clause_refs ?? [])) cited.add(c.replace(/^§\s*/, ""));
  for (const p of data.proposals) for (const c of p.payload.dispute?.clauseRefs ?? []) cited.add(c.replace(/^§\s*/, ""));
  const policies = data.policies.filter((p) => item.type === "SHARED_ALLOCATION" || p.learnedFromWorkItemId === item.id);

  return (
    <div className="pb-6">
      <Properties data={data} />
      <Numbers data={data} />
      <Outcome data={data} />

      <Section title="Checks at ingestion" count={item.checks.flags.length}>
        <ul className="space-y-1.5">
          {item.checks.flags.map((f) => (
            <li key={f.code} className="flex gap-2 text-[12px] leading-snug">
              <span
                className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", f.severity === "high" ? "bg-destructive" : f.severity === "medium" ? "bg-primary" : "bg-zinc-400")}
              />
              <span className="text-zinc-700">{f.message}</span>
            </li>
          ))}
        </ul>
      </Section>

      {data.proposals.length ? (
        <Section title="Proposals" count={data.proposals.length}>
          <ol className="space-y-4">
            {[...data.proposals].reverse().map((p) => {
              const decision = data.approvals.find((a) => a.subjectId === p.id && a.status !== "PENDING");
              return (
                <li key={p.id} className="space-y-1.5">
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="font-medium">
                      {p.id} v{p.version}
                    </span>
                    <span className="text-muted-foreground">{p.kind === "VENDOR_DISPUTE" ? "Vendor dispute" : "Allocation"}</span>
                    <span className={cn("ml-auto text-[11px] font-medium", STATUS_TEXT[p.status] ?? "text-zinc-500")}>{p.status.replace("_", " ").toLowerCase()}</span>
                  </div>
                  <AllocationTable proposal={p} projects={data.projects} />
                  {decision?.decisionReason ? (
                    <div className="text-[11.5px] text-zinc-600">
                      <span className="font-medium">{data.actors[decision.decidedBy ?? ""]?.name}:</span> {decision.decisionReason}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </Section>
      ) : null}

      {policies.length ? (
        <Section title="Allocation policy" count={policies.length}>
          <ol className="space-y-3">
            {[...policies].reverse().map((p) => (
              <li key={p.id}>
                <div className="flex items-center gap-2 text-[12px]">
                  <span className="font-medium">
                    {p.policyKey} v{p.version}
                  </span>
                  <span className={cn("ml-auto text-[11px] font-medium", STATUS_TEXT[p.status] ?? "text-zinc-500")}>{p.status.toLowerCase()}</span>
                </div>
                <p className="mt-1 text-[12px] leading-snug text-zinc-700">{p.statement}</p>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {p.approvedBy ? "Approved by " + (data.actors[p.approvedBy]?.name ?? p.approvedBy) + " " + dateOnly(p.approvedAt) : "Proposed by " + (data.actors[p.proposedBy]?.name ?? p.proposedBy)}
                  {p.learnedFromWorkItemId ? (
                    <>
                      {" "}
                      · learned from{" "}
                      <Link className="text-brand-ink hover:underline" href={"/investigations/" + p.learnedFromWorkItemId}>
                        {p.learnedFromWorkItemId}
                      </Link>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {line ? (
        <Section title="Provider invoice">
          <KV
            rows={[
              ["Invoice", invoice?.invoiceNumber],
              ["Line", <span key="l" className="font-mono text-[11px]">{line.externalLineId}</span>],
              ["Description", line.description],
              ["Quantity", line.quantity + " " + line.unit],
              ["Unit price", money(line.unitPriceCents)],
              ["Amount", <span key="a" className="tnum">{money(line.amountCents)}</span>],
              ["Service", dateTimeUtc(line.serviceStart) + " to " + dateTimeUtc(line.serviceEnd)],
            ]}
          />
          <SourceButton sourceType="invoice_line" sourceId={line.id} />
        </Section>
      ) : null}

      {data.reservation ? (
        <Section title="Reservation agreement">
          <KV
            rows={[
              ["Reservation", <span key="r" className="font-mono text-[11px]">{data.reservation.id}</span>],
              ["Owner", data.projects[data.reservation.ownerProjectId]?.name],
              ["Requested by", data.reservation.requestedBy],
              ["Capacity", data.reservation.gpuCount + " x " + data.reservation.gpuType + " for " + data.reservation.hours + " h"],
              ["Rate", money(data.reservation.rateCentsPerGpuHour) + " per GPU-hour"],
            ]}
          />
          <p className="mt-2 border-l-2 border-zinc-300 pl-3 text-[12px] leading-snug text-zinc-700">{data.reservation.internalTerms}</p>
          {data.policyFit ? (
            <p className={cn("mt-2 text-[12px] leading-snug", data.policyFit.fit.consistent ? "text-brand-ink" : "text-brand-ink")}>
              <span className="font-medium">
                {data.policyFit.policy ? data.policyFit.policy.policyKey + " v" + data.policyFit.policy.version : "No policy"}:
              </span>{" "}
              {data.policyFit.fit.consistent ? "fits the reservation terms." : data.policyFit.fit.conflicts.join(" ")}
            </p>
          ) : null}
          <SourceButton sourceType="reservation" sourceId={data.reservation.id} />
        </Section>
      ) : null}

      {data.lifecycle.length ? (
        <Section title="Instance lifecycle" count={data.lifecycle.length}>
          <ol className="space-y-1.5">
            {data.lifecycle.map((e) => (
              <li key={e.id} className="flex items-start gap-2 text-[12px]">
                <span className="w-[100px] shrink-0 font-mono text-[10.5px] text-zinc-600">{e.eventType}</span>
                <span className="flex-1 text-zinc-700">
                  {dateTimeUtc(e.occurredAt)}
                  <span className="block text-[11px] text-muted-foreground">
                    {e.source}
                    {e.reference ? " · " + e.reference : ""}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          {item.instanceId ? <SourceButton sourceType="lifecycle" sourceId={item.instanceId} /> : null}
        </Section>
      ) : null}

      <Section title="Experiments and jobs" count={data.jobs.length}>
        <div className="space-y-2">
          {data.experiments.map((exp) => (
            <div key={exp.id} className="text-[12px]">
              <div className="text-zinc-800">{exp.name}</div>
              <div className="text-[11px] text-muted-foreground">
                {exp.projectId ? data.projects[exp.projectId]?.name : "No project"} · {exp.owner}
              </div>
            </div>
          ))}
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 font-medium">Job</th>
                <th className="py-1 font-medium">GPUs</th>
                <th className="py-1 font-medium">Start</th>
                <th className="py-1 text-right font-medium">Hours</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((j) => (
                <tr key={j.id} className="border-t">
                  <td className="py-1 font-mono text-[10.5px]">{j.id}</td>
                  <td className="py-1 tnum">{j.gpus}</td>
                  <td className="py-1">{dateTimeUtc(j.startedAt)}</td>
                  <td className="py-1 text-right tnum">{((Date.parse(j.endedAt) - Date.parse(j.startedAt)) / 3_600_000).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {data.usage.length ? (
        <Section title="Provider usage meter" count={data.usage.length}>
          <div className="space-y-3">
            {data.usage.map((u) => (
              <KV
                key={u.id}
                rows={[
                  ["Metered", <span key="m" className="tnum">{u.hours} h</span>],
                  ["From", dateTimeUtc(u.usageStart)],
                  ["To", dateTimeUtc(u.usageEnd)],
                  ["Source", u.sourceRef],
                ]}
              />
            ))}
          </div>
          {item.instanceId ? <SourceButton sourceType="provider_usage" sourceId={item.instanceId} /> : null}
        </Section>
      ) : null}

      <Section title={"Contract " + contract.id} count={contract.clauses.length}>
        <ul className="space-y-2.5">
          {contract.clauses.map((c) => (
            <li key={c.ref} className={cn("text-[12px] leading-snug", cited.has(c.ref) && "border-l-2 border-primary/50 pl-2.5")}>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10.5px] text-zinc-500">§{c.ref}</span>
                <span className="font-medium text-zinc-800">{c.title}</span>
                {cited.has(c.ref) ? <span className="ml-auto text-[10.5px] text-brand-ink">cited</span> : null}
              </div>
              <p className="mt-0.5 text-zinc-600">{c.text}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Evidence" count={data.evidence.length}>
        {data.evidence.length === 0 ? <p className="text-[12px] text-muted-foreground">No evidence yet.</p> : null}
        <ul className="-mx-1.5">
          {data.evidence.map((ev) => (
            <li key={ev.id}>
              <button type="button" onClick={() => openEvidence(ev.id)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] hover:bg-zinc-100">
                <span className="flex-1 truncate text-zinc-700">{ev.label}</span>
                <span className="text-[10.5px] text-muted-foreground">{SIMULATED_SOURCES.has(ev.sourceType) ? "source" : "derived"}</span>
                <span className="text-[10.5px] text-muted-foreground tnum">{clockTime(ev.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
