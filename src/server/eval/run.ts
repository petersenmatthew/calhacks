import { and, desc, eq } from "drizzle-orm";
import { createAppContext, type AppContext } from "../context";
import { approvalRequests, invoiceLines, proposals, workItems } from "../db/schema";
import { formatCents } from "../domain/money";
import { Orchestrator } from "../orchestrator";
import { ACTOR } from "../security/actors";
import { setExecutionMode } from "../settings";
import { seedEnvironment } from "../sim/seed";
import { decideApproval } from "../workflow/approvals";
import { ONBOARDING_ID } from "../workflow/onboarding";
import type { IngestionResult } from "../workflow/ingestion";
import { answerKey, type Category, type EvalCase, type Expected } from "./answer-key";

/*
 * Runs every answer-key case in its own fresh sandbox (seeded month, the
 * learned materiality policy approved), lets the agents work, and compares
 * what they did with the key. Deterministic replay by default; LLM mode when
 * a model key is configured and requested.
 */

export interface Observed {
  outcome: string;
  detail: string;
  disputedCents?: number;
  totalCents?: number;
  lines?: Record<string, number>;
  posted?: boolean;
  workItemId?: string | null;
  itemOutcome?: string | null;
}

export interface CaseResult {
  id: string;
  title: string;
  planted: string;
  category: Category;
  expected: string;
  observed: string;
  pass: boolean;
  workItemId: string | null;
  ms: number;
}

export interface EvalReport {
  mode: "deterministic" | "llm";
  model: string | null;
  ranAt: string;
  total: number;
  passed: number;
  accuracy: number;
  overcharges: { planted: number; caught: number; plantedCents: number; caughtCents: number };
  falseDisputes: number;
  cases: CaseResult[];
}

function describeExpected(e: Expected) {
  switch (e.outcome) {
    case "auto_match":
      return "Auto-match and post";
    case "duplicate":
      return "Ignore duplicate";
    case "dispute":
      return "Dispute " + formatCents(e.disputedCents);
    case "allocate_full":
      return "Pay " + formatCents(e.totalCents) + " in full to owner" + (e.posted === true ? ", posted under policy" : "");
    case "accept_below_materiality":
      return "Accept below materiality, post " + formatCents(e.totalCents);
    case "allocation":
      return "Split " + Object.entries(e.lines).map(([p, c]) => p + " " + formatCents(c)).join(", ");
    case "escalate_conflict":
      return "Do not post; ask controller (policy conflict)";
    case "ask_human":
      return "Ask a person for the owner";
  }
}

function observe(ctx: AppContext, result: IngestionResult): Observed {
  if (result.status === "duplicate") return { outcome: "duplicate", detail: "Duplicate ignored" };
  if (result.status === "auto_matched") {
    const line = ctx.db.select().from(invoiceLines).where(eq(invoiceLines.id, result.invoiceLineId)).get();
    return { outcome: "auto_match", detail: "Auto-matched and posted " + formatCents(line?.amountCents ?? 0), totalCents: line?.amountCents, posted: true };
  }
  const item = ctx.db.select().from(workItems).where(eq(workItems.id, result.workItemId)).get()!;
  const proposal = ctx.db.select().from(proposals).where(eq(proposals.workItemId, item.id)).orderBy(desc(proposals.version)).get();
  const base = { workItemId: item.id, itemOutcome: item.outcome };
  if (item.state === "NEEDS_INFO") return { ...base, outcome: "ask_human", detail: "Asked: " + (item.pendingQuestion?.question ?? "") };
  if (!proposal) return { ...base, outcome: "none", detail: "No proposal; state " + item.state };
  const posted = item.state === "RESOLVED" || item.state === "POSTED";
  if (proposal.kind === "VENDOR_DISPUTE") {
    const d = proposal.payload.dispute!;
    return { ...base, outcome: "dispute", detail: "Dispute " + formatCents(d.disputedCents) + " (" + item.state + ")", disputedCents: d.disputedCents, posted };
  }
  const lines = Object.fromEntries(proposal.payload.allocation.map((l) => [l.projectId, l.amountCents]));
  const pending = ctx.db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.workItemId, item.id), eq(approvalRequests.status, "PENDING")))
    .get();
  return {
    ...base,
    outcome: "allocation",
    detail:
      proposal.method + ": " + Object.entries(lines).map(([p, c]) => p + " " + formatCents(c)).join(", ") +
      (posted ? " (posted" + (item.outcome ? ", " + item.outcome : "") + ")" : pending ? " (awaiting approval)" : " (" + item.state + ")"),
    totalCents: proposal.payload.totalCents,
    lines,
    posted,
  };
}

function matches(e: Expected, o: Observed) {
  switch (e.outcome) {
    case "auto_match":
    case "duplicate":
    case "ask_human":
      return o.outcome === e.outcome;
    case "dispute":
      return o.outcome === "dispute" && o.disputedCents === e.disputedCents;
    case "allocate_full": {
      const paid = (o.outcome === "allocation" && Object.keys(o.lines ?? {}).length === 1) || o.outcome === "auto_match";
      return paid && o.totalCents === e.totalCents && (e.posted === "either" || o.posted === e.posted);
    }
    case "accept_below_materiality":
      return o.outcome === "allocation" && o.totalCents === e.totalCents && o.posted === true && o.itemOutcome === "ACCEPTED_BELOW_MATERIALITY";
    case "allocation":
      return (
        o.outcome === "allocation" &&
        o.posted === e.posted &&
        Object.keys(e.lines).length === Object.keys(o.lines ?? {}).length &&
        Object.entries(e.lines).every(([p, c]) => o.lines?.[p] === c)
      );
    case "escalate_conflict":
      return o.outcome === "allocation" && o.posted === false;
  }
}

async function freshSandbox(mode: "deterministic" | "llm", model?: string) {
  const ctx = createAppContext({
    file: ":memory:",
    config: { stepDelayMs: 0, llmAvailable: mode === "llm", defaultMode: mode, ...(model ? { model } : {}) },
  });
  seedEnvironment(ctx);
  if (mode === "llm") setExecutionMode(ctx, ACTOR.controller, "llm");
  const orchestrator = new Orchestrator(ctx);
  await orchestrator.drain();
  const onboarding = ctx.db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.workItemId, ONBOARDING_ID), eq(approvalRequests.status, "PENDING")))
    .get();
  if (onboarding) decideApproval(ctx, { approvalId: onboarding.id, actorId: ACTOR.controller, decision: "APPROVED" });
  return { ctx, orchestrator };
}

export async function runEval(options: { mode?: "deterministic" | "llm"; model?: string; only?: string[] } = {}): Promise<EvalReport> {
  const mode = options.mode ?? "deterministic";
  const cases = answerKey().filter((c) => !options.only || options.only.includes(c.id));
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c, mode, options.model));
  const overcharges = results.filter((r) => r.category === "overcharge");
  const key = new Map(cases.map((c) => [c.id, c]));
  const plantedCents = overcharges.reduce((s, r) => s + ((key.get(r.id)!.expected as { disputedCents: number }).disputedCents ?? 0), 0);
  const caughtCents = overcharges
    .filter((r) => r.pass)
    .reduce((s, r) => s + ((key.get(r.id)!.expected as { disputedCents: number }).disputedCents ?? 0), 0);
  const passed = results.filter((r) => r.pass).length;
  return {
    mode,
    model: mode === "llm" ? options.model ?? null : null,
    ranAt: new Date().toISOString(),
    total: results.length,
    passed,
    accuracy: results.length ? passed / results.length : 0,
    overcharges: { planted: overcharges.length, caught: overcharges.filter((r) => r.pass).length, plantedCents, caughtCents },
    falseDisputes: results.filter((r) => r.category !== "overcharge" && r.observed.startsWith("Dispute")).length,
    cases: results,
  };
}

async function runCase(c: EvalCase, mode: "deterministic" | "llm", model?: string): Promise<CaseResult> {
  const started = Date.now();
  const { ctx, orchestrator } = await freshSandbox(mode, model);
  let observed: Observed;
  try {
    const result = c.run(ctx);
    await orchestrator.drain();
    observed = observe(ctx, result);
  } catch (error) {
    observed = { outcome: "error", detail: "Error: " + (error instanceof Error ? error.message : String(error)) };
  } finally {
    ctx.sqlite.close();
  }
  return {
    id: c.id,
    title: c.title,
    planted: c.planted,
    category: c.category,
    expected: describeExpected(c.expected),
    observed: observed.detail,
    pass: matches(c.expected, observed),
    workItemId: observed.workItemId ?? null,
    ms: Date.now() - started,
  };
}

export function reportMarkdown(r: EvalReport) {
  const pct = (x: number) => Math.round(x * 1000) / 10 + "%";
  const rows = r.cases.map(
    (c) => "| " + (c.pass ? "PASS" : "FAIL") + " | " + c.id + " | " + c.planted + " | " + c.expected + " | " + c.observed.replace(/\|/g, "/") + " |",
  );
  return [
    "# ExperimentLedger evaluation",
    "",
    "Generated by `npm run eval` on " + r.ranAt.slice(0, 10) + ". Mode: " + (r.mode === "llm" ? "LLM agents (" + (r.model ?? "default model") + ")" : "deterministic replay") + ".",
    "",
    "Each case runs in a fresh sandbox (the seeded October month, with the materiality policy the Finance Agent learned at onboarding approved). The expected outcome is hand-computed in `src/server/eval/answer-key.ts`.",
    "",
    "- **Accuracy:** " + r.passed + " / " + r.total + " (" + pct(r.accuracy) + ")",
    "- **Planted overcharges caught:** " + r.overcharges.caught + " / " + r.overcharges.planted + " (" + formatCents(r.overcharges.caughtCents) + " of " + formatCents(r.overcharges.plantedCents) + ")",
    "- **Correct invoices wrongly disputed:** " + r.falseDisputes,
    "",
    "| Result | Case | Planted | Expected | Observed |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
