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
  ALLOWED: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
  DENIED: "bg-rose-50 text-rose-700 ring-rose-600/15",
  FAILED: "bg-amber-50 text-amber-800 ring-amber-600/20",
};

const POLICY_TONE: Record<string, string> = {
  APPROVED: "bg-emerald-100 text-emerald-700",
  PROPOSED: "bg-orange-100 text-orange-700",
  SUPERSEDED: "bg-zinc-100 text-zinc-500",
  REJECTED: "bg-rose-100 text-rose-700",
};

function EventsTable({ data }: { data: AuditData }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const q = query.trim().toLowerCase();
  const rows = data.events.filter((e) => {
    if (filter === "decision" && e.category !== "decision") return false;
    if (filter === "posting" && e.category !== "posting") return false;
    if (filter === "denied" && e.outcome === "ALLOWED") return false;
    if (filter === "agents" && e.actorKind !== "agent") return false;
    if (!q) return true;
    return [e.action, e.workItemId, e.targetId, e.actorId, e.policyId, e.approvalId, e.rule].some((v) => (v ?? "").toLowerCase().includes(q));
  });
  return (
    <div className="rounded-xl bg-white ring-1 ring-zinc-200/80">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
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
              {f.label}
            </button>
          ))}
        </div>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by work item, action, policy, approval" className="ml-auto h-8 max-w-[300px] text-[12.5px]" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-[12px]">
          <thead>
            <tr className="border-b text-left text-[11px] text-muted-foreground">
              <th className="py-2 pr-2 pl-4 font-medium">#</th>
              <th className="px-2 py-2 font-medium">Time</th>
              <th className="px-2 py-2 font-medium">Actor</th>
              <th className="px-2 py-2 font-medium">Action</th>
              <th className="px-2 py-2 font-medium">Outcome</th>
              <th className="px-2 py-2 font-medium">Target</th>
              <th className="px-2 py-2 font-medium">Work item</th>
              <th className="px-2 py-2 font-medium">Rule / authorization</th>
              <th className="py-2 pr-4 pl-2 font-medium">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <Fragment key={e.id}>
                <tr onClick={() => setOpen(open === e.id ? null : e.id)} className="cursor-pointer border-b hover:bg-zinc-50">
                  <td className="py-2 pr-2 pl-4 font-mono text-[10.5px] text-muted-foreground">
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
                    <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-[10.5px] font-medium ring-1 ring-inset", OUTCOME_TONE[e.outcome])}>{e.outcome}</span>
                  </td>
                  <td className="px-2 py-2 font-mono text-[11px] whitespace-nowrap text-zinc-600">{e.targetId ?? "—"}</td>
                  <td className="px-2 py-2 font-mono text-[11px] whitespace-nowrap">
                    {e.workItemId ? (
                      <Link onClick={(ev) => ev.stopPropagation()} className="text-blue-700 hover:underline" href={"/investigations/" + e.workItemId}>
                        {e.workItemId}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-2 py-2 text-[11px] text-zinc-600">
                    {[e.rule, e.approvalId, e.policyId].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="py-2 pr-4 pl-2 text-[11px] text-muted-foreground tnum">{e.evidenceIds.length || ""}</td>
                </tr>
                {open === e.id ? (
                  <tr className="border-b bg-zinc-50/60">
                    <td colSpan={9} className="px-4 py-3">
                      <div className="grid gap-3 md:grid-cols-[1fr_320px]">
                        <JsonView value={e.details} className="max-h-60" />
                        <div className="space-y-1 font-mono text-[10.5px] text-zinc-600">
                          <div>ts {e.ts}</div>
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
    <div className="grid gap-4 lg:grid-cols-2">
      {keys.map((key) => (
        <div key={key} className="rounded-xl bg-white ring-1 ring-zinc-200/80">
          <div className="border-b px-4 py-3">
            <div className="text-[13px] font-semibold">{data.policies.find((p) => p.policyKey === key)?.title}</div>
            <div className="font-mono text-[11px] text-muted-foreground">{key}</div>
          </div>
          <ol className="divide-y">
            {data.policies
              .filter((p) => p.policyKey === key)
              .reverse()
              .map((p) => (
                <li key={p.id} className="space-y-1.5 px-4 py-3">
                  <div className="flex items-center gap-2 text-[12px]">
                    <span className="font-medium">v{p.version}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{p.rule.method}</span>
                    <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium", POLICY_TONE[p.status])}>{p.status}</span>
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
                      <Link className="text-blue-700 hover:underline" href={"/investigations/" + p.learnedFromWorkItemId}>
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
    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <div className="h-fit rounded-xl bg-white ring-1 ring-zinc-200/80">
        <div className="border-b px-4 py-3">
          <div className="text-[13px] font-semibold">Trial balance</div>
          <div className={cn("text-[11.5px]", debits === credits ? "text-emerald-700" : "text-rose-600")}>
            {debits === credits ? "Debits equal credits" : "Out of balance"}
          </div>
        </div>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="text-left text-[11px] text-muted-foreground">
              <th className="px-4 py-2 font-medium">Account</th>
              <th className="px-2 py-2 text-right font-medium">Debits</th>
              <th className="px-4 py-2 text-right font-medium">Credits</th>
            </tr>
          </thead>
          <tbody>
            {data.trialBalance.map((a) => (
              <tr key={a.code} className="border-t">
                <td className="px-4 py-2">
                  <span className="font-mono text-zinc-500">{a.code}</span> {a.name}
                </td>
                <td className="px-2 py-2 text-right tnum">{money(a.debits)}</td>
                <td className="px-4 py-2 text-right tnum">{money(a.credits)}</td>
              </tr>
            ))}
            <tr className="border-t font-medium">
              <td className="px-4 py-2">Total</td>
              <td className="px-2 py-2 text-right tnum">{money(debits)}</td>
              <td className="px-4 py-2 text-right tnum">{money(credits)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="rounded-xl bg-white ring-1 ring-zinc-200/80">
        <div className="border-b px-4 py-3 text-[13px] font-semibold">Journal entries</div>
        <ol className="divide-y">
          {data.journal.map((entry) => (
            <li key={entry.id}>
              <details className="px-4 py-2.5">
                <summary className="flex cursor-pointer items-center gap-3 text-[12px]">
                  <span className="font-mono text-[11px] text-zinc-500">{entry.id}</span>
                  <span className="min-w-0 flex-1 truncate">{entry.memo}</span>
                  <span className="hidden text-[11px] text-muted-foreground md:inline">{entry.source === "erp_ap" ? "ERP AP (simulated)" : "Ledger gateway"}</span>
                  <span className="font-medium tnum">{money(entry.totalCents)}</span>
                </summary>
                <div className="mt-2 space-y-2">
                  <div className="text-[11px] text-muted-foreground">
                    {dateTimeUtc(entry.postedAt)} · {entry.authorization}
                    {entry.workItemId ? (
                      <>
                        {" · "}
                        <Link className="text-blue-700 hover:underline" href={"/investigations/" + entry.workItemId}>
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
      <div className="mx-auto max-w-[1440px] space-y-5 px-6 py-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight">Audit trail</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Append-only record of every agent tool call, human decision, posting, and denied action, with the rule and approval behind it.
            </p>
          </div>
          {data ? (
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] ring-1",
                data.chain.ok ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-rose-50 text-rose-800 ring-rose-200",
              )}
            >
              {data.chain.ok ? <ShieldCheck className="size-4" /> : <ShieldX className="size-4" />}
              {data.chain.ok ? "Hash chain intact across " + data.chain.count + " events" : "Hash chain broken at event " + data.chain.brokenAtId}
            </div>
          ) : null}
        </div>
        {!data ? (
          <Skeleton className="h-[480px] rounded-xl" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                ["Audit events", data.chain.count],
                ["Allowed", data.counts.ALLOWED ?? 0],
                ["Denied", data.counts.DENIED ?? 0],
                ["Failed validation", data.counts.FAILED ?? 0],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl bg-white p-4 ring-1 ring-zinc-200/80">
                  <div className="text-[12px] text-muted-foreground">{label}</div>
                  <div className={cn("mt-1.5 text-[22px] font-semibold tnum", label === "Denied" && Number(value) > 0 && "text-rose-600")}>{value}</div>
                </div>
              ))}
            </div>
            <Tabs defaultValue="events">
              <TabsList>
                <TabsTrigger value="events">Events</TabsTrigger>
                <TabsTrigger value="policies">Policies</TabsTrigger>
                <TabsTrigger value="ledger">Journal and trial balance</TabsTrigger>
              </TabsList>
              <TabsContent value="events" className="mt-3">
                <EventsTable data={data} />
              </TabsContent>
              <TabsContent value="policies" className="mt-3">
                <PoliciesList data={data} />
              </TabsContent>
              <TabsContent value="ledger" className="mt-3">
                <Ledger data={data} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </div>
  );
}
