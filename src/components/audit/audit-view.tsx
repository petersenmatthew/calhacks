"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import useSWR from "swr";
import { Check, ChevronRight, ShieldCheck, ShieldX } from "lucide-react";
import { fetcher } from "@/lib/api";
import { clockTime, dateOnly, money } from "@/lib/format";
import { PROVIDER_SOURCE, SOURCE } from "@/lib/sources";
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
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "h-8 rounded-full px-3 text-[12.5px] font-medium ring-1 transition-colors",
                filter === f.key ? "bg-zinc-900 text-white ring-zinc-900" : "text-zinc-600 ring-zinc-200 hover:bg-zinc-50 hover:text-zinc-900",
              )}
            >
              {f.label} <span className={cn("ml-0.5 tnum", f.key === "denied" && counts.denied ? "text-destructive" : filter === f.key ? "text-white/55" : "text-zinc-400")}>{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by work item, action, policy, approval" className="ml-auto h-8 max-w-[300px] rounded-full px-3.5 text-[12.5px]" />
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

type Entry = AuditData["journal"][number];

type Step = { id: string; at: string; text: string; detail?: string; cents: number; tone?: "credit" };

type Charge = {
  key: string;
  vendor: string;
  logo?: string;
  line: string;
  what: string | null;
  workItemId: string | null;
  at: string;
  billed: number;
  teams: { name: string; cents: number }[];
  credited: number;
  waiting: number;
  steps: Step[];
};

const net = (e: Entry, code: string) => e.lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.debitCents - l.creditCents, 0);

function how(auth: string, data: AuditData) {
  if (/^standing policy/i.test(auth)) return "automatically, under standing policy";
  const by = auth.match(/by (.+)$/);
  if (by) return "approved by " + (by[1].split(" ")[0] === data.actors["human.controller"]?.name.split(" ")[0] ? "you" : by[1]);
  return auth;
}

/** Group journal entries into one story per invoice line: billed, where it went, what came back. */
function charges(data: AuditData): Charge[] {
  const groups = new Map<string, Entry[]>();
  for (const e of data.journal) {
    const k = e.invoiceLineId ?? e.id;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return [...groups.entries()]
    .map(([key, entries]) => {
      const sorted = [...entries].sort((a, b) => a.postedAt.localeCompare(b.postedAt) || a.id.localeCompare(b.id));
      const invoice = sorted.find((e) => e.source === "erp_ap");
      const vendor = invoice?.lines.find((l) => l.accountCode === "2000")?.memo ?? "Vendor";
      const provider = Object.values(data.providers).find((p) => p.shortName === vendor);
      const sid = provider ? PROVIDER_SOURCE[provider.id] : undefined;
      const teams = new Map<string, number>();
      const steps: Step[] = [];
      for (const e of sorted) {
        if (e.source === "erp_ap") {
          steps.push({ id: e.id, at: e.postedAt, text: "Invoice recorded", detail: "Owed to " + vendor, cents: e.totalCents });
          continue;
        }
        const toTeams = e.lines.filter((l) => l.accountCode === "6100" && l.debitCents > l.creditCents);
        for (const l of toTeams) {
          const name = (l.projectId && data.projects[l.projectId]?.name) || "a team";
          teams.set(name, (teams.get(name) ?? 0) + l.debitCents - l.creditCents);
          steps.push({ id: e.id, at: e.postedAt, text: "Charged to " + name, detail: how(e.authorization, data), cents: l.debitCents - l.creditCents });
        }
        const credit = net(e, "2000");
        if (credit > 0) {
          const memo = e.lines.find((l) => l.accountCode === "2000")?.memo.match(/CM-[\w-]+/)?.[0];
          steps.push({ id: e.id, at: e.postedAt, text: vendor + " credited it back", detail: memo ? "Credit memo " + memo : undefined, cents: credit, tone: "credit" });
        }
        if (!toTeams.length && credit <= 0) steps.push({ id: e.id, at: e.postedAt, text: e.memo, detail: e.authorization, cents: e.totalCents });
      }
      const what = invoice?.lines.find((l) => l.accountCode === "6990")?.memo ?? null;
      return {
        key,
        vendor,
        logo: sid ? SOURCE[sid].logo : undefined,
        line: invoice?.invoiceLineId ?? key,
        what,
        workItemId: sorted.find((e) => e.workItemId)?.workItemId ?? null,
        at: sorted[sorted.length - 1].postedAt,
        billed: invoice?.totalCents ?? 0,
        teams: [...teams.entries()].map(([name, cents]) => ({ name, cents })),
        credited: sorted.reduce((s, e) => s + Math.max(0, net(e, "2000")), 0),
        waiting: sorted.reduce((s, e) => s + net(e, "6990"), 0),
        steps,
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

const usd = (c: number) => money(c, { cents: c % 100 !== 0 });

function ChargeRow({ c }: { c: Charge }) {
  const [open, setOpen] = useState(false);
  const story = [
    ...c.teams.map((t) => usd(t.cents) + " to " + t.name),
    c.credited ? usd(c.credited) + " credited back" : null,
    c.waiting > 0 ? usd(c.waiting) + " not assigned yet" : null,
  ].filter(Boolean);
  return (
    <li>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-3 px-6 py-3 text-left hover:bg-zinc-50">
        {c.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.logo} alt="" className="size-8 shrink-0 rounded-lg ring-1 ring-zinc-200" />
        ) : (
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-zinc-100 text-[11px] font-semibold text-zinc-500">{c.vendor[0]}</span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-[13px] text-zinc-900">
            <span className="font-medium">{c.vendor}</span>
            <span className="truncate text-zinc-500">{c.what?.split(":")[0] ?? c.line}</span>
          </span>
          <span className="block truncate text-[12px] text-zinc-500">{story.join(" · ") || "Recorded"}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block text-[13px] font-medium text-zinc-900 tnum">{usd(c.billed)}</span>
          {c.waiting > 0 ? (
            <span className="block text-[11px] font-medium text-amber-700">Waiting</span>
          ) : (
            <span className="flex items-center justify-end gap-1 text-[11px] text-brand-ink">
              <Check className="size-3" strokeWidth={3} /> Settled
            </span>
          )}
        </span>
        <ChevronRight className={cn("size-4 shrink-0 text-zinc-400 transition-transform", open && "rotate-90")} />
      </button>
      {open ? (
        <div className="px-6 pb-4 pl-[68px]">
          <ol className="relative space-y-3 border-l border-zinc-200 pl-4">
            {c.steps.map((s, i) => (
              <li key={s.id + i} className="relative">
                <span className={cn("absolute top-1.5 -left-[21px] size-2 rounded-full ring-2 ring-white", s.tone === "credit" ? "bg-primary" : "bg-zinc-300")} />
                <div className="flex items-baseline gap-3 text-[12.5px]">
                  <span className="text-zinc-800">{s.text}</span>
                  <span className={cn("ml-auto tnum", s.tone === "credit" ? "text-brand-ink" : "text-zinc-700")}>{(s.tone === "credit" ? "−" : "") + usd(s.cents)}</span>
                </div>
                <div className="flex gap-2 text-[11.5px] text-zinc-500">
                  <span>{[dateOnly(s.at), s.detail].filter(Boolean).join(" · ")}</span>
                  <span className="ml-auto font-mono text-[10.5px] text-zinc-400">{s.id}</span>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex gap-3 text-[11.5px] text-zinc-500">
            <span className="font-mono">{c.line}</span>
            {c.workItemId ? (
              <Link href={"/canvas?task=" + c.workItemId} className="text-brand-ink hover:underline">
                Open {c.workItemId}
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function Ledger({ data }: { data: AuditData }) {
  const list = charges(data);
  const billed = list.reduce((s, c) => s + c.billed, 0);
  const toTeams = list.reduce((s, c) => s + c.teams.reduce((t, x) => t + x.cents, 0), 0);
  const credited = list.reduce((s, c) => s + c.credited, 0);
  const waiting = list.reduce((s, c) => s + Math.max(0, c.waiting), 0);
  const debits = data.trialBalance.reduce((s, a) => s + a.debits, 0);
  const credits = data.trialBalance.reduce((s, a) => s + a.credits, 0);
  const stats = [
    { label: "Billed by vendors", value: billed, tone: "text-zinc-900" },
    { label: "Charged to teams", value: toTeams, tone: "text-zinc-900" },
    { label: "Credited back", value: credited, tone: "text-brand-ink" },
    { label: "Not assigned yet", value: waiting, tone: waiting ? "text-amber-700" : "text-zinc-400" },
  ];
  return (
    <div className="mx-auto max-w-[880px] pb-10">
      <div className="grid grid-cols-2 gap-3 px-6 pt-6 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl bg-white px-4 py-3 ring-1 ring-zinc-200">
            <div className="text-[11.5px] text-zinc-500">{s.label}</div>
            <div className={cn("mt-0.5 text-[18px] font-semibold tracking-[-0.01em] tnum", s.tone)}>{money(s.value, { cents: false })}</div>
          </div>
        ))}
      </div>
      <div className="flex items-baseline justify-between px-6 pt-6 pb-2">
        <h3 className="text-[13px] font-semibold text-zinc-900">Charges</h3>
        <span className={cn("flex items-center gap-1 text-[11.5px]", debits === credits ? "text-brand-ink" : "text-destructive")}>
          {debits === credits ? <Check className="size-3" strokeWidth={3} /> : null}
          {debits === credits ? "Books balance" : "Books out of balance"}
        </span>
      </div>
      <ol className="mx-6 divide-y overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200 [&>li>button]:px-4 [&>li>div]:pl-[60px]">
        {list.map((c) => (
          <ChargeRow key={c.key} c={c} />
        ))}
      </ol>
    </div>
  );
}

export function AuditView() {
  const { data, mutate } = useSWR<AuditData>("/api/audit", fetcher, { keepPreviousData: true });
  useLiveRefresh(() => mutate(), undefined, 800);
  return (
    <div className="h-full overflow-y-auto">
      <Tabs defaultValue="events" className="gap-0">
        <header className="px-6 pt-7 pb-4">
          <div className="flex items-end gap-4">
            <div>
              <h1 className="text-[24px] leading-[1.15] font-semibold tracking-[-0.02em] text-zinc-950">Audit trail</h1>
              <p className="mt-1.5 text-[14px] text-zinc-600">Every step the team took, every posting, and every call you made.</p>
            </div>
          {data ? (
            <span className={cn("ml-auto flex items-center gap-1.5 rounded-full px-3 py-1 text-[12.5px] font-medium", data.chain.ok ? "bg-accent text-brand-ink" : "bg-destructive/10 text-destructive")}>
              {data.chain.ok ? <ShieldCheck className="size-3.5" /> : <ShieldX className="size-3.5" />}
              {data.chain.ok ? "Hash chain intact · " + data.chain.count + " events" : "Hash chain broken at event " + data.chain.brokenAtId}
            </span>
          ) : null}
          </div>
          <TabsList variant="line" className="mt-5 -ml-1 h-8 gap-1 p-0">
            {(["events", "policies", "ledger"] as const).map((v) => (
              <TabsTrigger
                key={v}
                value={v}
                className="h-8 flex-none rounded-lg px-2.5 text-[13px] capitalize after:hidden data-active:bg-zinc-100! data-active:text-zinc-900"
              >
                {v}
              </TabsTrigger>
            ))}
          </TabsList>
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
