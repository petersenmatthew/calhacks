import type { WorkspaceData } from "@/server/queries";
import { money } from "./format";

/*
 * The wrap-up shown when a task closes: the money, who did what, and how long
 * it took. Built from the task's own records (no model call), so it appears the
 * moment the task closes and every number matches the ledger.
 */

export type SummaryFigure = { label: string; value: string; tone?: "good" | "muted" };
export type SummaryStep = { actorId: string; text: string };
export type TaskSummary = {
  figures: SummaryFigure[];
  steps: SummaryStep[];
  took: string | null;
  agents: number;
  you: number;
  /** Where the billed money went, in cents. */
  flow: { billed: number; charged: number; recovered: number; lost: number };
};

const DONE = new Set(["RESOLVED", "POSTED"]);

export function isDone(state: string) {
  return DONE.has(state);
}

const whole = (c: number) => money(c, { cents: c % 100 !== 0 });

function firstSentence(text: string) {
  const s = text.replace(/\s+/g, " ").trim();
  const cut = s.search(/(?<=[a-z0-9)%])\.\s/i);
  const one = cut > 0 ? s.slice(0, cut + 1) : s;
  return one.length > 160 ? one.slice(0, 157) + "…" : one;
}

function duration(ms: number) {
  if (ms < 60_000) return Math.max(1, Math.round(ms / 1000)) + " s";
  if (ms < 3_600_000) return Math.round(ms / 60_000) + " min";
  if (ms < 86_400_000) return (ms / 3_600_000).toFixed(ms < 36_000_000 ? 1 : 0).replace(/\.0$/, "") + " h";
  return Math.round(ms / 86_400_000) + " days";
}

export function taskSummary(w: WorkspaceData): TaskSummary {
  const lines = w.journal.flatMap((e) => e.lines);
  const charged = lines.filter((l) => l.accountCode === "6100").reduce((s, l) => s + l.debitCents - l.creditCents, 0);
  const d = w.dispute;
  const credited = d && d.status === "CREDIT_ACCEPTED" ? (d.creditedCents ?? d.amountCents) : 0;
  const billed = w.item.amountCents;

  const figures: SummaryFigure[] = [{ label: "Billed", value: whole(billed) }];
  if (credited > 0) figures.push({ label: "Recovered", value: whole(credited), tone: "good" });
  if (charged > 0) {
    const teams = new Set(lines.filter((l) => l.accountCode === "6100" && l.debitCents > l.creditCents && l.projectId).map((l) => l.projectId));
    figures.push({ label: teams.size > 1 ? "Charged, " + teams.size + " teams" : "Charged to team", value: whole(charged) });
  }
  if (d && d.status === "DENIED") figures.push({ label: "Not recovered", value: whole(d.amountCents), tone: "muted" });

  const steps: SummaryStep[] = [];
  const finding = [...w.findings].reverse().find((f) => f.kind === "compute" || f.kind === "capacity");
  if (finding) steps.push({ actorId: finding.agentId, text: firstSentence(finding.summary) });
  const executed = [...w.proposals].reverse().find((p) => p.status === "EXECUTED" || p.status === "APPROVED");
  if (executed) {
    const dispute = executed.payload.dispute;
    steps.push({
      actorId: executed.createdBy,
      text: dispute
        ? "Proposed disputing " + whole(dispute.disputedCents) + " and paying " + whole(dispute.undisputedCents) + "."
        : "Proposed booking " + whole(executed.payload.totalCents) + (executed.payload.allocation.filter((l) => l.amountCents > 0).length > 1 ? " across teams." : " to the owning team."),
    });
  }
  const decided = w.approvals.filter((a) => a.status !== "PENDING" && a.decidedBy);
  for (const a of decided) {
    const verb = a.status === "APPROVED" ? "Approved" : a.status === "REJECTED" ? "Rejected" : "Asked for changes to";
    const budgetAsk = a.decisionReason && /^Set the .+ budget to /.test(a.decisionReason);
    steps.push({
      actorId: a.decidedBy!,
      text:
        verb + " " + (a.subjectType === "POLICY" ? "the policy" : "the proposal") +
        (budgetAsk ? " and asked for a budget change." : a.decisionReason ? ": “" + firstSentence(a.decisionReason) + "”" : "."),
    });
  }
  if (!decided.length && executed?.authorization?.startsWith("Standing")) {
    steps.push({ actorId: "system.ledger_gateway", text: "Covered by a standing policy, so it booked without asking you." });
  }
  // A budget change the controller asked for alongside their approval.
  for (const a of w.activity) {
    if (a.toolName !== "set_project_budget" || a.status !== "ok") continue;
    const r = (a.result ?? {}) as Record<string, unknown>;
    const name = w.projects[String(r.project_id ?? "")]?.name ?? "the project";
    steps.push({ actorId: a.actorId, text: "Changed the " + name + " budget from " + String(r.previous_budget ?? "?").replace(/\.00$/, "") + " to " + String(r.monthly_budget ?? "?").replace(/\.00$/, "") + " a month, as you asked." });
  }
  if (d) {
    const replies = w.vendorMessages.filter((m) => m.direction === "inbound" && m.status !== "ignored").length;
    const answers = w.vendorMessages.filter((m) => m.direction === "outbound").length;
    const ref = d.vendorReference ? " (" + d.vendorReference + ")" : "";
    steps.push({ actorId: "agent.vendor", text: "Emailed the dispute" + ref + " with the evidence" + (replies ? ", read " + replies + " " + (replies === 1 ? "reply" : "replies") + (answers ? " and answered " + answers : "") : "") + "." });
    if (d.status === "CREDIT_ACCEPTED") {
      steps.push({ actorId: "agent.vendor", text: (credited < d.amountCents ? "Booked the " + whole(credited) + " credit you accepted" : "Booked the " + whole(credited) + " credit") + (d.creditMemoRef ? " (" + d.creditMemoRef + ")" : "") + " and closed the case." });
    } else if (d.status === "DENIED") {
      steps.push({ actorId: "agent.vendor", text: "The vendor refused; booked the charge to the owning team and closed the case." });
    }
  }
  if (w.journal.length) {
    steps.push({ actorId: "system.ledger_gateway", text: "Posted " + w.journal.map((e) => e.id).join(", ") + "; every entry balances and is in the audit trail." });
  }

  const times = w.activity.map((a) => Date.parse(a.createdAt)).filter(Number.isFinite);
  const took = times.length > 1 ? duration(Math.max(...times) - Math.min(...times)) : null;
  const agents = new Set(w.activity.filter((a) => a.actorId.startsWith("agent.")).map((a) => a.actorId)).size;
  const you = w.approvals.filter((a) => a.status !== "PENDING" && a.decidedBy?.startsWith("human.")).length + w.findings.filter((f) => f.kind === "human").length;
  return { figures, steps, took, agents, you, flow: { billed, charged, recovered: credited, lost: d && d.status === "DENIED" ? d.amountCents : 0 } };
}
