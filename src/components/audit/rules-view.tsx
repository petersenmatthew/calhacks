"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight, History, MessageSquareText } from "lucide-react";
import { dateOnly, money } from "@/lib/format";
import { ruleTitle } from "@/lib/frames";
import { cn } from "@/lib/utils";
import type { AuditData } from "@/server/queries";
import { PixelAgent } from "../pixel-agent";

type Policy = AuditData["policies"][number];

const learnedByAgent = (p: Policy) => p.proposedBy.startsWith("agent.");
const titleOf = (p: Policy) => ruleTitle(p.policyKey, p.rule.method, p.rule);
const when = (p: Policy) => p.approvedAt ?? p.createdAt;
const short = (iso: string) => {
  const d = new Date(iso);
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
};

/** Where a rule version came from, in a few words. */
function source(p: Policy, data: AuditData) {
  const q = data.ruleStories[p.id]?.quote;
  if (!learnedByAgent(p)) return { icon: BookOpen, text: "Company policy" };
  if (q) return { icon: MessageSquareText, text: "Learned from your " + q.kind + " on " + q.workItemId };
  if (p.learnedFromWorkItemId) return { icon: MessageSquareText, text: "Learned on " + p.learnedFromWorkItemId };
  return { icon: History, text: "Learned from AP history" };
}

function usage(p: Policy, data: AuditData) {
  const cases = data.ruleStories[p.id]?.cases ?? [];
  return { n: cases.length, booked: cases.reduce((s, c) => s + c.totalCents, 0), cases };
}

/** The main view: how the team's rules changed, newest first. */
function Changelog({ data, onOpen }: { data: AuditData; onOpen: (key: string) => void }) {
  const [current, setCurrent] = useState(false);
  const live = data.policies.filter((p) => p.status === "APPROVED");
  const fromYou = live.filter((p) => data.ruleStories[p.id]?.quote).length;
  const handled = live.reduce((s, p) => s + usage(p, data).n, 0);
  const rows = [...data.policies]
    .filter((p) => !current || p.status === "APPROVED" || p.status === "PROPOSED")
    .sort((a, b) => when(b).localeCompare(when(a)));

  return (
    <div className="mx-auto max-w-[880px] px-6 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[20px] font-semibold tracking-[-0.01em]">How the rules changed</h2>
          <p className="mt-1 text-[13.5px] text-zinc-500">
            {live.length} rule{live.length === 1 ? "" : "s"} live · {fromYou} learned from you · {handled} case{handled === 1 ? "" : "s"} handled without you
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCurrent(!current)}
          className={cn("rounded-full px-3 py-1 text-[12.5px]", current ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200")}
        >
          Show current rules only
        </button>
      </div>

      <div className="mt-8 space-y-5">
        {rows.map((p) => {
          const prior = data.policies.find((x) => x.id === p.supersedesId);
          const q = data.ruleStories[p.id]?.quote;
          const src = source(p, data);
          const u = usage(p, data);
          const replacedBy = data.policies.find((x) => x.supersedesId === p.id && x.status === "APPROVED");
          const changed = learnedByAgent(p) && Boolean(prior);
          const head =
            p.status === "PROPOSED"
              ? "Waiting for you: a new rule from the Controls Lead"
              : p.status === "REJECTED"
                ? "You turned down a proposed rule"
                : changed
                  ? "You changed a rule"
                  : learnedByAgent(p)
                    ? src.text
                    : "Company policy added";
          const impact =
            p.status === "PROPOSED"
              ? "Not in use until you approve it"
              : p.status === "REJECTED"
                ? "Never used"
                : p.status === "SUPERSEDED"
                  ? (u.n ? "Used on " + u.n + " case" + (u.n === 1 ? "" : "s") + " · " : "") + "Replaced " + (replacedBy ? short(when(replacedBy)) : "")
                  : u.n
                    ? "Used on " + u.n + " case" + (u.n === 1 ? "" : "s") + " since · " + money(u.booked, { cents: false }) + " booked without you"
                    : "Not used yet";
          return (
            <div key={p.id} className="grid grid-cols-[96px_1fr] gap-5">
              <div className="pt-5 text-right text-[12.5px] text-zinc-400 tnum">{short(when(p))}</div>
              <button
                type="button"
                onClick={() => onOpen(p.policyKey)}
                className={cn(
                  "group w-full rounded-2xl p-5 text-left ring-1 transition-shadow hover:ring-zinc-400",
                  p.status === "PROPOSED" ? "ring-amber-300" : changed && p.status === "APPROVED" ? "ring-primary/40" : "ring-zinc-200",
                  (p.status === "SUPERSEDED" || p.status === "REJECTED") && "opacity-70",
                )}
              >
                <div className="flex items-center gap-2 text-[12.5px] text-zinc-500">
                  {learnedByAgent(p) ? <PixelAgent actorId="agent.policy" size={20} still /> : <src.icon className="size-3.5" />}
                  {head}
                  <span className="ml-auto font-mono text-[11px] text-zinc-400">
                    {p.policyKey} v{p.version}
                  </span>
                </div>
                {q ? <div className="mt-3 inline-block rounded-2xl rounded-bl-md bg-zinc-100 px-3.5 py-2 text-[14px] leading-snug text-zinc-800">&ldquo;{q.text}&rdquo;</div> : null}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[15.5px]">
                  {changed && prior ? (
                    <>
                      <span className="text-zinc-400 line-through decoration-zinc-300">{titleOf(prior)}</span>
                      <ArrowRight className="size-4 text-zinc-400" />
                    </>
                  ) : null}
                  <span className={cn("font-semibold", p.status === "SUPERSEDED" || p.status === "REJECTED" ? "text-zinc-500" : "text-zinc-900")}>{titleOf(p)}</span>
                </div>
                <div className="mt-2 flex items-center text-[12.5px] text-zinc-500">
                  {impact}
                  <ChevronRight className="ml-auto size-4 text-zinc-300 group-hover:text-zinc-500" />
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One rule: what it does now, what it has done, and every version that led here. */
function RuleDetail({ data, policyKey, onBack, className }: { data: AuditData; policyKey: string; onBack: () => void; className: string }) {
  const versions = data.policies.filter((p) => p.policyKey === policyKey).sort((a, b) => b.version - a.version);
  const r = versions.find((p) => p.status === "APPROVED") ?? versions[0];
  const u = usage(r, data);
  const name = (projectId: string) => data.projects[projectId]?.name ?? projectId;
  return (
    <div className={className}>
      <button type="button" onClick={onBack} className="mb-5 flex items-center gap-1 text-[13px] text-zinc-500 hover:text-zinc-900">
        <ArrowLeft className="size-3.5" /> All rules
      </button>
      <div className="font-mono text-[11.5px] tracking-wider text-zinc-400 uppercase">
        {r.policyKey} v{r.version} · {r.status === "APPROVED" ? "live since " + short(when(r)) : r.status.toLowerCase()}
      </div>
      <h2 className="mt-1 text-[26px] font-semibold tracking-[-0.01em]">{titleOf(r)}</h2>
      <p className="mt-2 text-[15px] leading-relaxed text-zinc-600">{r.statement}</p>

      <div className="mt-6 grid grid-cols-3 gap-3">
        {[
          ["Cases handled", String(u.n)],
          ["Booked without you", money(u.booked, { cents: false })],
          ["Auto-book limit", money(r.rule.autoPostLimitCents, { cents: false })],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl p-4 ring-1 ring-zinc-200">
            <div className="text-[12px] text-zinc-500">{k}</div>
            <div className="mt-1 text-[22px] font-semibold tnum">{v}</div>
          </div>
        ))}
      </div>

      <div className="mt-8 text-[13px] font-medium text-zinc-500">How it got here</div>
      <div className="mt-3 space-y-5 border-l-2 border-zinc-100 pl-5">
        {versions.map((v) => {
          const q = data.ruleStories[v.id]?.quote;
          const src = source(v, data);
          const gone = v.status === "SUPERSEDED" || v.status === "REJECTED";
          return (
            <div key={v.id} className="relative">
              <span className={cn("absolute top-1.5 -left-[27px] size-3 rounded-full ring-4 ring-white", v.status === "APPROVED" ? "bg-primary" : v.status === "PROPOSED" ? "bg-amber-400" : "bg-zinc-300")} />
              <div className="flex items-center gap-2 text-[14px]">
                <span className={cn("font-medium", gone ? "text-zinc-400 line-through decoration-zinc-300" : "text-zinc-900")}>{titleOf(v)}</span>
                <span className="font-mono text-[11px] text-zinc-400">v{v.version}</span>
                {v.status === "PROPOSED" ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">waiting for you</span> : null}
              </div>
              <div className="text-[12.5px] text-zinc-500">
                {src.text} · {dateOnly(when(v))}
                {v.approvedBy ? " · approved by " + (data.actors[v.approvedBy]?.name ?? v.approvedBy) : ""}
              </div>
              {q ? <div className="mt-2 inline-block rounded-2xl rounded-bl-md bg-zinc-100 px-3.5 py-2 text-[13.5px] text-zinc-800">&ldquo;{q.text}&rdquo;</div> : null}
            </div>
          );
        })}
      </div>

      <div className="mt-8 text-[13px] font-medium text-zinc-500">Used on</div>
      {u.cases.length ? (
        <div className="mt-2 divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200">
          {u.cases.map((c) => (
            <Link
              key={c.entryId}
              href={c.workItemId ? "/canvas?task=" + c.workItemId : "#"}
              className="flex items-center gap-3 px-4 py-2.5 text-[13.5px] hover:bg-zinc-50"
            >
              <span className="font-mono text-[12px] text-zinc-400">{c.workItemId ?? c.entryId}</span>
              <span className="truncate text-zinc-700">
                {c.invoiceLineId}
                {c.charged.length ? " → " + c.charged.map((x) => name(x.projectId)).join(", ") : ""}
              </span>
              <span className="ml-auto tnum">{money(c.totalCents, { cents: false })}</span>
              <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-brand-ink">without you</span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[13.5px] text-zinc-500">No case has used this rule yet.</p>
      )}
    </div>
  );
}

/** The Rules tab: a changelog of how the rules changed; a rule's full story opens in the same column. */
export function RulesView({ data }: { data: AuditData }) {
  const [open, setOpen] = useState<string | null>(null);
  return open ? (
    <RuleDetail data={data} policyKey={open} onBack={() => setOpen(null)} className="mx-auto max-w-[880px] px-6 py-8" />
  ) : (
    <Changelog data={data} onOpen={setOpen} />
  );
}
