"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Check, CircleCheck, CircleX, LoaderCircle, Play, X } from "lucide-react";
import { fetcher, postJson } from "@/lib/api";
import { dateTimeUtc, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EvalReport } from "@/server/eval/run";
import type { AutonomyData } from "@/server/queries";
import { useLiveRefresh } from "../live-events";
import { AgentAvatar } from "../status";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";

function Section({ title, sub, children, aside }: { title: string; sub: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="border-t px-6 py-6">
      <div className="mb-4 flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <p className="mt-0.5 max-w-2xl text-[12.5px] leading-snug text-muted-foreground">{sub}</p>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

const DAY = 86_400_000;
const days = (ms: number) => Math.round(ms / DAY) + (Math.round(ms / DAY) === 1 ? " day" : " days");

const KIND_LABEL: Record<string, string> = {
  APPROVAL_REMINDER: "Reminded approver",
  APPROVAL_ESCALATION: "Escalated to CFO",
  DISPUTE_CHASE: "Assigned vendor chase",
  DISPUTE_ESCALATION: "Assigned dispute escalation",
  VENDOR_MESSAGE: "Agent messaged vendor",
  ESCALATION_NOTE: "Agent escalated dispute",
};

function Onboarding({ data, refresh }: { data: AutonomyData; refresh: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const policy = data.onboarding.policies[data.onboarding.policies.length - 1];
  const pending = data.onboarding.approvals.find((a) => a.status === "PENDING" && a.subjectId === policy?.id);
  const run = data.onboarding.runs[data.onboarding.runs.length - 1];
  const decide = async (decision: "APPROVED" | "REJECTED") => {
    if (!pending) return;
    if (decision === "REJECTED" && reason.trim().length < 3) {
      toast.error("Add a reason so the agent knows what was wrong.");
      return;
    }
    setBusy(decision);
    try {
      await postJson("/api/approvals/" + pending.id, { decision, reason: reason.trim() || null });
      toast.success(decision === "APPROVED" ? "Policy approved. Small variances now post without a dispute." : "Policy rejected.");
      refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const steps = data.onboarding.activity.filter((e) => e.toolName || e.type === "POLICY" || e.type === "AGENT_FINISHED");
  return (
    <Section
      title="Onboarding: learned from AP history"
      sub="On its first day the Finance Agent read six months of the ERP's AP lines and wrote down the rule the team followed but never documented."
    >
      {!run ? (
        <p className="text-[12.5px] text-muted-foreground">Waiting for the onboarding run to start.</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="card-soft p-4">
            {policy ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold">
                    {policy.policyKey} v{policy.version}
                  </span>
                  <span
                    className={cn(
                      "ml-auto rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                      policy.status === "APPROVED" ? "bg-accent text-brand-ink" : policy.status === "REJECTED" ? "bg-destructive/10 text-destructive" : "bg-zinc-100 text-zinc-600",
                    )}
                  >
                    {policy.status === "PROPOSED" ? "awaiting your approval" : policy.status.toLowerCase()}
                  </span>
                </div>
                <p className="mt-2 text-[13px] leading-snug text-zinc-800">{policy.statement}</p>
                <p className="mt-2 text-[12px] leading-snug text-zinc-600">{policy.rationale}</p>
                <div className="mt-3 text-[12px] text-muted-foreground">
                  Threshold <span className="font-medium text-zinc-800 tnum">{money(policy.rule.thresholdCents ?? 0)}</span> per line · line limit{" "}
                  {money(policy.rule.autoPostLimitCents, { cents: false })}
                </div>
                {pending ? (
                  <div className="mt-4 space-y-2">
                    <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required to reject)" rows={1} className="min-h-[38px] text-[12.5px]" />
                    <div className="flex gap-1.5">
                      <Button size="sm" onClick={() => decide("APPROVED")} disabled={busy !== null}>
                        {busy === "APPROVED" ? <LoaderCircle className="animate-spin" /> : <Check />} Approve policy
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => decide("REJECTED")} disabled={busy !== null}>
                        {busy === "REJECTED" ? <LoaderCircle className="animate-spin" /> : <X />} Reject
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-[12.5px] text-muted-foreground">{run.status === "running" ? "Reading history…" : "No policy proposed."}</p>
            )}
          </div>
          <ol className="space-y-2">
            {steps.map((e) => (
              <li key={e.id} className="flex gap-2 text-[12px] leading-snug">
                <AgentAvatar actorId={e.actorId} size="sm" className="mt-0.5" />
                <span className="min-w-0">
                  <span className="text-zinc-800">{e.title}</span>
                  {e.summary && e.type !== "POLICY" ? <span className="block text-[11.5px] text-muted-foreground">{e.summary}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </Section>
  );
}

function Feeds({ data }: { data: AutonomyData }) {
  return (
    <Section
      title="Billing feeds"
      sub={
        "The scheduler pulls new invoice lines every " + Math.round(data.scheduler.intervalMs / 1000) +
        " s with a cursor per source, so a re-sync never re-reads or duplicates a line. Lines publish over business time; move the clock forward to receive them."
      }
    >
      {data.scheduler.intervalMs === 0 ? <p className="mb-3 text-[12px] text-destructive">The scheduler is off (AUTONOMY=off).</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[12.5px]">
          <thead>
            <tr className="border-b text-left text-[11px] text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Synced</th>
              <th className="px-3 py-2 font-medium">Cursor</th>
              <th className="px-3 py-2 font-medium">Last sync</th>
              <th className="py-2 pl-3 font-medium">Next line publishes</th>
            </tr>
          </thead>
          <tbody>
            {data.feeds.map((f) => (
              <tr key={f.source} className="border-b">
                <td className="py-2 pr-3">{f.label}</td>
                <td className="px-3 py-2 tnum">
                  {f.synced} of {f.total}
                  {f.published > f.synced ? <span className="text-brand-ink"> · {f.published - f.synced} ready</span> : null}
                </td>
                <td className="px-3 py-2 font-mono text-[11.5px] text-zinc-600">{f.cursor ?? "—"}</td>
                <td className="px-3 py-2 text-zinc-600">{f.syncedAt ? dateTimeUtc(f.syncedAt) : "never"}</td>
                <td className="py-2 pl-3 text-zinc-600">{f.nextAt ? dateTimeUtc(f.nextAt) : "nothing scheduled"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function FollowUps({ data }: { data: AutonomyData }) {
  const rules = [
    { label: "Remind the approver", after: data.rules.approvalReminderMs },
    { label: "Escalate the approval to the CFO", after: data.rules.approvalEscalationMs },
    { label: "Finance Agent chases the vendor", after: data.rules.disputeChaseMs },
    { label: "Finance Agent escalates the dispute", after: data.rules.disputeEscalationMs },
  ];
  return (
    <Section title="Time-based follow-ups" sub="Checked on the business clock. Each action happens once and is written to the audit trail.">
      <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <ul className="space-y-1.5 text-[12.5px]">
          {rules.map((r) => (
            <li key={r.label} className="flex justify-between gap-3">
              <span className="text-zinc-700">{r.label}</span>
              <span className="whitespace-nowrap text-muted-foreground tnum">after {days(r.after)}</span>
            </li>
          ))}
        </ul>
        {data.followUps.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">Nothing has waited long enough yet.</p>
        ) : (
          <ol className="divide-y text-[12.5px]">
            {data.followUps.map((f) => (
              <li key={f.id} className="flex items-baseline gap-3 py-1.5">
                <span className="w-44 shrink-0 text-zinc-800">{KIND_LABEL[f.kind] ?? f.kind}</span>
                <span className="font-mono text-[11.5px] text-zinc-600">{f.subjectId}</span>
                {f.workItemId && f.workItemId !== "ONBOARDING" ? (
                  <Link href={"/investigations/" + f.workItemId} className="font-mono text-[11.5px] text-brand-ink hover:underline">
                    {f.workItemId}
                  </Link>
                ) : null}
                <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{dateTimeUtc(f.businessAt)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Section>
  );
}

function Evaluation() {
  const { data, mutate } = useSWR<{ reports: Partial<Record<"deterministic" | "llm", EvalReport>>; running: boolean; llmAvailable: boolean }>("/api/eval", fetcher);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<"deterministic" | "llm">("deterministic");
  const report = data?.reports[mode] ?? data?.reports.deterministic ?? data?.reports.llm;
  const run = async (m: "deterministic" | "llm") => {
    setBusy(m);
    setMode(m);
    try {
      await postJson("/api/eval", { mode: m });
      await mutate();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Section
      title="Evaluation against an answer key"
      sub="Fourteen invoice lines with planted errors and hand-computed correct outcomes. Each runs in its own throwaway sandbox; the live data is not touched."
      aside={
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => run("deterministic")} disabled={busy !== null}>
            {busy === "deterministic" ? <LoaderCircle className="animate-spin" /> : <Play />} Run (deterministic)
          </Button>
          {data?.llmAvailable ? (
            <Button size="sm" variant="outline" onClick={() => run("llm")} disabled={busy !== null}>
              {busy === "llm" ? <LoaderCircle className="animate-spin" /> : <Play />} Run (LLM)
            </Button>
          ) : null}
        </div>
      }
    >
      {!report ? (
        <p className="text-[12.5px] text-muted-foreground">Not run yet in this server session. It takes a few seconds in deterministic mode.</p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-x-8 gap-y-2 text-[12.5px]">
            <span>
              <span className="text-[18px] font-semibold tnum">
                {report.passed}/{report.total}
              </span>{" "}
              <span className="text-muted-foreground">correct ({report.mode === "llm" ? "LLM" : "deterministic replay"})</span>
            </span>
            <span>
              <span className="font-medium tnum">
                {report.overcharges.caught}/{report.overcharges.planted}
              </span>{" "}
              <span className="text-muted-foreground">overcharges caught ({money(report.overcharges.caughtCents)})</span>
            </span>
            <span>
              <span className="font-medium tnum">{report.falseDisputes}</span> <span className="text-muted-foreground">correct invoices disputed</span>
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-[12px]">
              <thead>
                <tr className="border-b text-left text-[11px] text-muted-foreground">
                  <th className="py-2 pr-2 font-medium" />
                  <th className="px-2 py-2 font-medium">Planted</th>
                  <th className="px-2 py-2 font-medium">Expected</th>
                  <th className="py-2 pl-2 font-medium">What the agents did</th>
                </tr>
              </thead>
              <tbody>
                {report.cases.map((c) => (
                  <tr key={c.id} className="border-b align-top">
                    <td className="py-2 pr-2">
                      {c.pass ? <CircleCheck className="size-4 text-brand-ink" /> : <CircleX className="size-4 text-destructive" />}
                    </td>
                    <td className="px-2 py-2">
                      <div className="text-zinc-800">{c.title}</div>
                      <div className="text-[11.5px] text-muted-foreground">{c.planted}</div>
                    </td>
                    <td className="px-2 py-2 text-zinc-700">{c.expected}</td>
                    <td className="py-2 pl-2 text-zinc-700">{c.observed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}

export function AutonomyView() {
  const { data, mutate } = useSWR<AutonomyData>("/api/autonomy", fetcher, { keepPreviousData: true, refreshInterval: 10_000 });
  useLiveRefresh(() => mutate(), undefined, 500);
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl pb-10">
        <div className="px-6 pt-6 pb-5">
          <h1 className="text-[16px] font-semibold tracking-tight">What runs without you</h1>
          <p className="mt-1 max-w-2xl text-[12.5px] leading-snug text-muted-foreground">
            Work starts from billing feeds and the calendar, not from clicks. Business time now:{" "}
            <span className="text-zinc-800 tnum">{data ? dateTimeUtc(data.clock.now) : "…"}</span>
            {data && data.clock.offsetMs > 0 ? " (moved " + days(data.clock.offsetMs) + " ahead for the demo)" : ""}.
          </p>
        </div>
        {!data ? (
          <div className="px-6">
            <Skeleton className="h-64 rounded-lg" />
          </div>
        ) : (
          <>
            <Onboarding data={data} refresh={() => mutate()} />
            <Feeds data={data} />
            <FollowUps data={data} />
          </>
        )}
        <Evaluation />
      </div>
    </div>
  );
}
