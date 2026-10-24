"use client";

import { useState } from "react";
import { ChevronRight, FileSearch } from "lucide-react";
import { clockTime, dateTimeUtc, hours, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InstanceChecks, ReservationChecks } from "@/server/db/schema";
import { ReservationUsage } from "./reservation-usage";
import { UsageTimeline } from "./usage-timeline";
import { SIMULATED_SOURCES, useWorkspace } from "./workspace-context";

function Section({ title, count, defaultOpen = false, children }: { title: string; count?: number; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-4 py-2.5 text-left hover:bg-zinc-50">
        <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="flex-1 text-[12.5px] font-medium">{title}</span>
        {count !== undefined ? <span className="text-[11px] text-muted-foreground tnum">{count}</span> : null}
      </button>
      {open ? <div className="px-4 pb-3">{children}</div> : null}
    </div>
  );
}

function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
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
    <button type="button" onClick={() => openEvidence(ev.id)} className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-medium text-blue-700 hover:underline">
      <FileSearch className="size-3.5" /> View source record ({ev.id})
    </button>
  );
}

export function ContextPanel() {
  const { data, openEvidence } = useWorkspace();
  const { item, line, invoice, contract } = data;
  const isInstance = item.type === "BILLING_VARIANCE";
  const checks = item.checks;
  const inst = checks as InstanceChecks;
  const resv = checks as ReservationChecks;
  const cited = new Set<string>();
  for (const f of data.findings) for (const c of ((f.data as { clause_refs?: string[] }).clause_refs ?? [])) cited.add(c.replace(/^§\s*/, ""));
  for (const p of data.proposals) for (const c of p.payload.dispute?.clauseRefs ?? []) cited.add(c.replace(/^§\s*/, ""));

  return (
    <div>
      <div className="px-4 pt-4 pb-3">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold">Financial context</h2>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-600">Simulated source systems</span>
        </div>
        {isInstance ? (
          <div className="grid grid-cols-3 overflow-hidden rounded-lg border bg-white">
            <div className="p-3">
              <div className="text-[11px] text-muted-foreground">Vendor invoice</div>
              <div className="mt-1 text-[15px] font-semibold tnum">{money(item.invoicedCents)}</div>
              <div className="text-[10.5px] text-muted-foreground tnum">
                {inst.billedHours} h x {money(inst.invoicedRateCents)}
              </div>
            </div>
            <div className="border-l p-3">
              <div className="text-[11px] text-muted-foreground">Expected charge</div>
              <div className="mt-1 text-[15px] font-semibold tnum">{money(item.expectedCents)}</div>
              <div className="text-[10.5px] text-muted-foreground tnum">
                {inst.billableHours} h x {money(inst.contractRateCents)}
              </div>
            </div>
            <div className={cn("border-l p-3", item.discrepancyCents >= 100 ? "bg-rose-50" : "bg-emerald-50/60")}>
              <div className="text-[11px] text-muted-foreground">Potential discrepancy</div>
              <div className={cn("mt-1 text-[15px] font-semibold tnum", item.discrepancyCents >= 100 ? "text-rose-600" : "text-emerald-700")}>
                {money(item.discrepancyCents, { sign: true })}
              </div>
              <div className="text-[10.5px] text-muted-foreground">
                {item.discrepancyCents >= 100 ? hours(inst.billedHours - inst.billableHours) + " not supported" : "matches contract"}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-3 overflow-hidden rounded-lg border bg-white">
            <div className="p-3">
              <div className="text-[11px] text-muted-foreground">Reservation charge</div>
              <div className="mt-1 text-[15px] font-semibold tnum">{money(item.invoicedCents)}</div>
            </div>
            <div className="border-l p-3">
              <div className="text-[11px] text-muted-foreground">Committed</div>
              <div className="mt-1 text-[15px] font-semibold tnum">{money(item.expectedCents)}</div>
            </div>
            <div className="border-l bg-orange-50/60 p-3">
              <div className="text-[11px] text-muted-foreground">To allocate</div>
              <div className="mt-1 text-[15px] font-semibold text-orange-700 tnum">{resv.usageByProject.length} teams</div>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-3 px-4 pb-4">
        {isInstance ? <UsageTimeline data={data} /> : <ReservationUsage data={data} />}
        <div className="rounded-lg border bg-white p-3">
          <div className="mb-1.5 text-[11.5px] font-medium text-zinc-700">Deterministic checks at ingestion</div>
          <ul className="space-y-1">
            {checks.flags.map((f) => (
              <li key={f.code} className="flex gap-2 text-[11.5px] leading-snug">
                <span
                  className={cn(
                    "mt-1 size-1.5 shrink-0 rounded-full",
                    f.severity === "high" ? "bg-rose-500" : f.severity === "medium" ? "bg-amber-500" : "bg-zinc-400",
                  )}
                />
                <span>
                  <span className="font-mono text-[10.5px] text-zinc-500">{f.code}</span> <span className="text-zinc-700">{f.message}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {line ? (
        <Section title="Provider invoice" defaultOpen>
          <KV
            rows={[
              ["Provider", data.providers[item.providerId]?.name],
              ["Invoice", invoice?.invoiceNumber],
              ["Line", <span key="l" className="font-mono text-[11px]">{line.externalLineId}</span>],
              ["Description", line.description],
              ["Quantity", line.quantity + " " + line.unit],
              ["Unit price", money(line.unitPriceCents)],
              ["Amount", <span key="a" className="font-medium tnum">{money(line.amountCents)}</span>],
              ["Service", dateTimeUtc(line.serviceStart) + " to " + dateTimeUtc(line.serviceEnd)],
            ]}
          />
          <SourceButton sourceType="invoice_line" sourceId={line.id} />
        </Section>
      ) : null}

      {data.reservation ? (
        <Section title="Reservation agreement" defaultOpen>
          <KV
            rows={[
              ["Reservation", <span key="r" className="font-mono text-[11px]">{data.reservation.id}</span>],
              ["Owner", data.projects[data.reservation.ownerProjectId]?.name],
              ["Requested by", data.reservation.requestedBy],
              ["Capacity", data.reservation.gpuCount + " x " + data.reservation.gpuType + " for " + data.reservation.hours + " h"],
              ["Rate", money(data.reservation.rateCentsPerGpuHour) + " per GPU-hour"],
            ]}
          />
          <blockquote className="mt-2 rounded-md border-l-2 border-zinc-300 bg-zinc-50 px-3 py-2 text-[12px] leading-snug text-zinc-700">
            {data.reservation.internalTerms}
          </blockquote>
          {data.policyFit ? (
            <div
              className={cn(
                "mt-2 rounded-md px-3 py-2 text-[11.5px] leading-snug",
                data.policyFit.fit.consistent ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900",
              )}
            >
              <span className="font-medium">
                {data.policyFit.policy ? data.policyFit.policy.policyKey + " v" + data.policyFit.policy.version : "No policy"}:
              </span>{" "}
              {data.policyFit.fit.consistent ? "fits the reservation terms." : data.policyFit.fit.conflicts.join(" ")}
            </div>
          ) : null}
          <SourceButton sourceType="reservation" sourceId={data.reservation.id} />
        </Section>
      ) : null}

      <Section title="Experiments and scheduler jobs" count={data.jobs.length}>
        <div className="space-y-2">
          {data.experiments.map((exp) => (
            <div key={exp.id} className="text-[12px]">
              <div className="font-medium text-zinc-800">{exp.name}</div>
              <div className="text-[11px] text-muted-foreground">
                <span className="font-mono">{exp.id}</span> · {exp.projectId ? data.projects[exp.projectId]?.name : "no project"} · {exp.owner}
              </div>
            </div>
          ))}
          <table className="mt-1 w-full text-[11.5px]">
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

      {data.lifecycle.length ? (
        <Section title="Instance lifecycle" count={data.lifecycle.length} defaultOpen>
          <ol className="space-y-1.5">
            {data.lifecycle.map((e) => (
              <li key={e.id} className="flex items-start gap-2 text-[11.5px]">
                <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", e.eventType === "TERMINATED" ? "bg-rose-500" : e.eventType === "PROVISIONED" ? "bg-teal-500" : "bg-zinc-400")} />
                <span className="w-[108px] shrink-0 font-mono text-[10.5px] text-zinc-700">{e.eventType}</span>
                <span className="flex-1 text-zinc-600">
                  {dateTimeUtc(e.occurredAt)}
                  <span className="block text-[10.5px] text-muted-foreground">
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

      {data.usage.length ? (
        <Section title="Provider usage meter" count={data.usage.length}>
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
          {item.instanceId ? <SourceButton sourceType="provider_usage" sourceId={item.instanceId} /> : null}
        </Section>
      ) : null}

      <Section title={"Contract " + contract.id} count={contract.clauses.length}>
        <ul className="space-y-2">
          {contract.clauses.map((c) => (
            <li key={c.ref} className={cn("rounded-md px-2.5 py-2 text-[11.5px] leading-snug", cited.has(c.ref) ? "bg-amber-50 ring-1 ring-amber-200" : "bg-zinc-50")}>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10.5px] text-zinc-500">§{c.ref}</span>
                <span className="font-medium text-zinc-800">{c.title}</span>
                {cited.has(c.ref) ? <span className="ml-auto text-[10px] font-medium text-amber-700">cited by agent</span> : null}
              </div>
              <p className="mt-0.5 text-zinc-600">{c.text}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Evidence collected by agents" count={data.evidence.length} defaultOpen={false}>
        {data.evidence.length === 0 ? <p className="text-[11.5px] text-muted-foreground">No evidence yet.</p> : null}
        <ul className="space-y-1">
          {data.evidence.map((ev) => (
            <li key={ev.id}>
              <button type="button" onClick={() => openEvidence(ev.id)} className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11.5px] hover:bg-zinc-100">
                <span className="font-mono text-[10.5px] text-zinc-400">{ev.id}</span>
                <span className="flex-1 truncate text-zinc-700">{ev.label}</span>
                <span className="text-[10px] text-muted-foreground">{SIMULATED_SOURCES.has(ev.sourceType) ? "source" : "derived"}</span>
                <span className="text-[10px] text-muted-foreground tnum">{clockTime(ev.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
