"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import useSWR from "swr";
import { ChevronRight, ShieldCheck, ShieldX } from "lucide-react";
import { fetcher } from "@/lib/api";
import { clockTime, dateOnly, dateTimeUtc, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AuditData } from "@/server/queries";
import { JsonView } from "../json-view";
import { useLiveRefresh } from "../live-events";
import { AgentAvatar } from "../status";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

type Filter = "all" | "decision" | "posting" | "denied" | "agents";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "decision", label: "Decisions" },
  { key: "posting", label: "Postings" },
  { key: "agents", label: "Agent tool calls" },
  { key: "denied", label: "Denied or failed" },
];

const OUTCOME_TONE: Record<string, string> = {
  ALLOWED: "text-zinc-500",
  DENIED: "text-destructive",
  FAILED: "text-brand-ink",
};

const POLICY_TONE: Record<string, string> = {
  APPROVED: "text-brand-ink",
  PROPOSED: "text-brand-ink",
  SUPERSEDED: "text-zinc-400",
  REJECTED: "text-destructive",
};

function EventsTable({ data }: { data: AuditData }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const q = query.trim().toLowerCase();
  const counts: Record<Filter, number> = {
    all: data.events.length,
    decision: data.events.filter((e) => e.category === "decision").length,
    posting: data.events.filter((e) => e.category === "posting").length,
    agents: data.events.filter((e) => e.actorKind === "agent").length,
    denied: data.events.filter((e) => e.outcome !== "ALLOWED").length,
  };
  const rows = data.events.filter((e) => {
    if (filter === "decision" && e.category !== "decision") return false;
    if (filter === "posting" && e.category !== "posting") return false;
    if (filter === "denied" && e.outcome === "ALLOWED") return false;
    if (filter === "agents" && e.actorKind !== "agent") return false;
    if (!q) return true;
    return [e.action, e.workItemId, e.targetId, e.actorId, e.policyId, e.approvalId, e.rule].some((v) => (v ?? "").toLowerCase().includes(q));
  });
  return (
    <div className="border-t">
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2.5">
        <div className="flex rounded-lg bg-zinc-100 p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12px] font-medium",
                filter === f.key ? "bg-white text-zinc-900 shadow-xs" : "text-zinc-500 hover:text-zinc-800",
              )}
            >
              {f.label} <span className={cn("ml-0.5 tnum", f.key === "denied" && counts.denied ? "text-destructive" : "text-zinc-400")}>{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by work item, action, policy, approval" className="ml-auto h-8 max-w-[300px] text-[12.5px]" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-[12px]">
          <thead>
            <tr className="border-b text-left text-[11px] text-muted-foreground">
              <th className="py-2 pr-2 pl-6 font-medium">#</th>
              <th className="px-2 py-2 font-medium">Time</th>
              <th className="px-2 py-2 font-medium">Actor</th>
              <th className="px-2 py-2 font-medium">Action</th>
              <th className="px-2 py-2 font-medium">Outcome</th>
              <th className="px-2 py-2 font-medium whitespace-nowrap">Work item</th>
              <th className="px-2 py-2 font-medium">Rule / authorization</th>

            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <Fragment key={e.id}>
                <tr onClick={() => setOpen(open === e.id ? null : e.id)} className="cursor-pointer border-b hover:bg-zinc-50">
                  <td className="py-2 pr-2 pl-6 font-mono text-[10.5px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <ChevronRight className={cn("size-3 transition-transform", open === e.id && "rotate-90")} />
                      {e.id}
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono text-[11px] text-zinc-600 tnum">{clockTime(e.ts)}</td>
                  <td className="px-2 py-2">
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      <AgentAvatar actorId={e.actorId} size="sm" />
                      {data.actors[e.actorId]?.name ?? e.actorId}
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono text-[11px]">{e.action}</td>
                  <td className="px-2 py-2">
                    <span className={cn("text-[11px] font-medium", OUTCOME_TONE[e.outcome])}>{e.outcome.toLowerCase()}</span>
                  </td>
                  <td className="px-2 py-2 font-mono text-[11px] whitespace-nowrap">
                    {e.workItemId ? (
                      <Link onClick={(ev) => ev.stopPropagation()} className="text-brand-ink hover:underline" href={"/canvas?task=" + e.workItemId}>
                        {e.workItemId}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-2 pr-6 pl-2 text-[11px] text-zinc-600">
                    {[e.rule, e.approvalId, e.policyId].filter(Boolean).join(" · ") || "—"}
                  </td>
                </tr>
                {open === e.id ? (
                  <tr className="border-b bg-zinc-50/60">
                    <td colSpan={7} className="px-6 py-3">
                      <div className="grid gap-3 md:grid-cols-[1fr_320px]">
                        <JsonView value={e.details} className="max-h-60" />
                        <div className="space-y-1 font-mono text-[10.5px] text-zinc-600">
                          <div>ts {e.ts}</div>
                          {e.targetId ? <div className="break-all">target {e.targetId}</div> : null}
                          <div className="break-all">prev {e.prevHash}</div>
                          <div className="break-all">hash {e.hash}</div>
                          {e.evidenceIds.length ? <div className="break-all">evidence {e.evidenceIds.join(", ")}</div> : null}
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? <div className="px-4 py-10 text-center text-[12.5px] text-muted-foreground">No events match.</div> : null}
      </div>
    </div>
  );
}

function PoliciesList({ data }: { data: AuditData }) {
  const keys = [...new Set(data.policies.map((p) => p.policyKey))];
  return (
    <div className="grid border-t lg:grid-cols-2 lg:divide-x">
      {keys.map((key) => (
        <div key={key} className="border-b">
          <div className="border-b px-6 py-3">
            <div className="text-[13px] font-semibold">{data.policies.find((p) => p.policyKey === key)?.title}</div>
            <div className="font-mono text-[11px] text-muted-foreground">{key}</div>
          </div>
          <ol className="divide-y">
            {data.policies
              .filter((p) => p.policyKey === key)
              .reverse()
              .map((p) => (
                <li key={p.id} className="space-y-1.5 px-6 py-3">
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="font-medium">v{p.version}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{p.rule.method}</span>
                    <span className={cn("ml-auto text-[11px] font-medium", POLICY_TONE[p.status])}>{p.status.toLowerCase()}</span>
                  </div>
                  <p className="text-[12px] leading-snug text-zinc-700">{p.statement}</p>
                  <div className="text-[11px] text-muted-foreground">
                    {p.approvedBy
                      ? "Approved by " + (data.actors[p.approvedBy]?.name ?? p.approvedBy) + " on " + dateOnly(p.approvedAt) + (p.approvalId ? " (" + p.approvalId + ")" : " (historical)")
                      : "Proposed by " + (data.actors[p.proposedBy]?.name ?? p.proposedBy) + ", awaiting decision"}
                    {" · auto-post limit " + money(p.rule.autoPostLimitCents, { cents: false })}
                  </div>
                  {p.learnedFromWorkItemId ? (
                    <div className="text-[11px] text-muted-foreground">
                      Learned from{" "}
                      <Link className="text-brand-ink hover:underline" href={"/canvas?task=" + p.learnedFromWorkItemId}>
                        {p.learnedFromWorkItemId}
                      </Link>{" "}
                      · precedents {p.precedentIds.join(", ") || "none"} · {p.evidenceIds.length} evidence references
                    </div>
                  ) : null}
                </li>
              ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function Ledger({ data }: { data: AuditData }) {
  const debits = data.trialBalance.reduce((s, a) => s + a.debits, 0);
  const credits = data.trialBalance.reduce((s, a) => s + a.credits, 0);
  return (
    <div className="grid border-t lg:grid-cols-[360px_minmax(0,1fr)] lg:divide-x">
      <div>
        <div className="border-b px-6 py-3">
          <div className="text-[13px] font-semibold">Trial balance</div>
          <div className={cn("text-[11.5px]", debits === credits ? "text-brand-ink" : "text-destructive")}>
            {debits === credits ? "Debits equal credits" : "Out of balance"}
          </div>
        </div>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[11px] text-muted-foreground">
              <th className="px-6 py-2 font-medium">Account</th>
              <th className="px-2 py-2 text-right font-medium">Debits</th>
              <th className="px-6 py-2 text-right font-medium">Credits</th>
            </tr>
          </thead>
          <tbody>
            {data.trialBalance.map((a) => (
              <tr key={a.code} className="border-t">
                <td className="px-6 py-2">
                  <span className="font-mono text-zinc-500">{a.code}</span> {a.name}
                </td>
                <td className="px-2 py-2 text-right tnum">{money(a.debits)}</td>
                <td className="px-6 py-2 text-right tnum">{money(a.credits)}</td>
              </tr>
            ))}
            <tr className="border-t font-medium">
              <td className="px-6 py-2">Total</td>
              <td className="px-2 py-2 text-right tnum">{money(debits)}</td>
              <td className="px-6 py-2 text-right tnum">{money(credits)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div>
        <div className="border-b px-6 py-3 text-[13px] font-semibold">Journal entries</div>
        <ol className="divide-y">
          {data.journal.map((entry) => (
            <li key={entry.id}>
              <details className="px-6 py-2.5">
                <summary className="flex cursor-pointer items-center gap-3 text-[12px]">
                  <span className="font-mono text-[11px] text-zinc-500">{entry.id}</span>
                  <span className="min-w-0 flex-1 truncate">{entry.memo}</span>
                  <span className="hidden text-[11px] text-muted-foreground md:inline">
                    {entry.source === "erp_ap" ? (data.erpConnected ? "Vendor bill" : "ERP AP (simulated)") : "Ledger gateway"}
                  </span>
                  {entry.erp?.url ? (
                    <a
                      className="font-mono text-[11px] text-brand-ink hover:underline"
                      href={entry.erp.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title="Open in Odoo"
                    >
                      {entry.erp.name}
                    </a>
                  ) : entry.erp?.status === "failed" ? (
                    <span className="text-[11px] text-destructive" title={entry.erp.error ?? ""}>
                      Odoo retrying
                    </span>
                  ) : null}
                  <span className="font-medium tnum">{money(entry.totalCents)}</span>
                </summary>
                <div className="mt-2 space-y-2">
                  <div className="text-[11px] text-muted-foreground">
                    {dateTimeUtc(entry.postedAt)} · {entry.authorization}
                    {entry.workItemId ? (
                      <>
                        {" · "}
                        <Link className="text-brand-ink hover:underline" href={"/canvas?task=" + entry.workItemId}>
                          {entry.workItemId}
                        </Link>
                      </>
                    ) : null}
                    {entry.proposalId ? " · " + entry.proposalId : ""}
                    {entry.approvalId ? " · " + entry.approvalId : ""}
                    {entry.policyId ? " · " + entry.policyId : ""}
                  </div>
                  <table className="w-full text-[11.5px]">
                    <tbody>
                      {entry.lines.map((l) => (
                        <tr key={l.id} className="border-t">
                          <td className="py-1">
                            <span className="font-mono text-zinc-500">{l.accountCode}</span> {data.accounts.find((a) => a.code === l.accountCode)?.name}
                            {l.projectId ? <span className="text-muted-foreground"> · {data.projects[l.projectId]?.name}</span> : null}
                          </td>
                          <td className="py-1 text-right tnum">{l.debitCents ? money(l.debitCents) : ""}</td>
                          <td className="w-28 py-1 text-right tnum">{l.creditCents ? money(l.creditCents) : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function AuditView() {
  const { data, mutate } = useSWR<AuditData>("/api/audit", fetcher, { keepPreviousData: true });
  useLiveRefresh(() => mutate(), undefined, 800);
  return (
    <div className="h-full overflow-y-auto">
      <Tabs defaultValue="events" className="gap-0">
        <header className="flex h-11 items-center gap-4 border-b px-6">
          <TabsList className="h-7">
            <TabsTrigger value="events" className="text-[12px]">Events</TabsTrigger>
            <TabsTrigger value="policies" className="text-[12px]">Policies</TabsTrigger>
            <TabsTrigger value="ledger" className="text-[12px]">Ledger</TabsTrigger>
          </TabsList>
          {data ? (
            <span className={cn("ml-auto flex items-center gap-1.5 text-[12px]", data.chain.ok ? "text-brand-ink" : "text-destructive")}>
              {data.chain.ok ? <ShieldCheck className="size-3.5" /> : <ShieldX className="size-3.5" />}
              {data.chain.ok ? "Hash chain intact · " + data.chain.count + " events" : "Hash chain broken at event " + data.chain.brokenAtId}
            </span>
          ) : null}
        </header>
        {!data ? (
          <div className="px-6">
            <Skeleton className="h-[480px] rounded-lg" />
          </div>
        ) : (
          <>
            <TabsContent value="events">
              <EventsTable data={data} />
            </TabsContent>
            <TabsContent value="policies">
              <PoliciesList data={data} />
            </TabsContent>
            <TabsContent value="ledger">
              <Ledger data={data} />
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}
