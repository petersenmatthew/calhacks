/**
 * Turns a task into the smallest decision a person can make: one sentence,
 * one picture, and two or three choices. Everything is derived from stored
 * checks, proposals and approvals, so nothing here invents facts.
 */
import { money } from "./format";
import type { InstanceChecks, ReservationChecks } from "@/server/db/schema";
import type { DashboardData, WorkspaceData } from "@/server/queries";

type Item = DashboardData["workItems"][number];
type Proposal = WorkspaceData["proposals"][number];

export type Segment = { key: string; label: string; value: number; tone: "a" | "b" | "c" | "d" | "idle" };

/** One picture per decision. Bars share a scale so differences read at a glance. */
export type Proof =
  | {
      kind: "compare";
      unit: "h" | "$" | "$/h";
      /** First row is what was billed, second is what is owed. The gap is the point. */
      billed: { label: string; value: number };
      owed: { label: string; value: number };
      /** Optional marker on the scale, such as the auto-approve limit. */
      marker?: { label: string; value: number };
    }
  | { kind: "usage"; reserved: number; segments: Segment[]; ownerKey: string };

export type Action =
  | { type: "approve" }
  | { type: "reject"; reason: string }
  | { type: "changes"; reason: string; directive?: "usage_proportional" | "owner_pays_idle" | "owner_pays_all" }
  | { type: "answer"; answer: string };

export type Choice = {
  id: string;
  label: string;
  /** Small text under or beside the label. Keep to a few words. */
  hint?: string;
  primary?: boolean;
  /** For split decisions: how the money lands under this choice. */
  split?: Segment[];
  tag?: string;
  action: Action;
};

export type DecisionKind = "dispute" | "book" | "split" | "rule" | "owner" | "vendor";

export type Decision = {
  kind: DecisionKind;
  approvalId: string | null;
  askedBy: string;
  /** Provider and resource, shown small above the title. */
  context: string;
  title: string;
  /** The question itself, as short as possible. */
  ask: string;
  proof: Proof | null;
  choices: Choice[];
  /** Up to three short facts behind the recommendation, shown on demand. */
  why: string[];
  /** Whether a free-text "something else" answer makes sense. */
  custom: "changes" | "answer" | null;
};

const TONES: Segment["tone"][] = ["a", "b", "c", "d"];

export function projectTone(projectId: string, order: string[]): Segment["tone"] {
  const i = order.indexOf(projectId);
  return TONES[(i < 0 ? order.length : i) % TONES.length];
}

function providerName(w: { providers: WorkspaceData["providers"] }, id: string) {
  return w.providers[id]?.shortName ?? w.providers[id]?.name ?? id;
}

const h = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-US");
const whole = (c: number) => money(c, { cents: c % 100 !== 0 });

/* ------------------------------------------------------------ short titles */

/** A few words for a task, for lists. Falls back to the stored title. */
export function shortTitle(item: Pick<Item, "title" | "type" | "resource" | "providerId">, providers: DashboardData["providers"]) {
  const p = providers[item.providerId]?.shortName ?? providers[item.providerId]?.name ?? "";
  const t = item.title;
  if (/past instance lifetime/i.test(t)) return p + " billed after shutdown";
  if (/twice/i.test(t)) return p + " billed twice";
  if (/rate above contract/i.test(t)) return p + " rate over contract";
  if (/rate below contract/i.test(t)) return p + " rate under contract";
  if (/exceeds scheduler runtime/i.test(t)) return p + " idle hours";
  if (/unattributed/i.test(t)) return "Untagged " + p + " charge";
  if (item.type === "SHARED_ALLOCATION") return "Split " + p + " reservation";
  return t;
}

/** The verb a waiting task needs from you, for list rows. */
export function askVerb(item: Pick<Item, "type" | "state" | "discrepancyCents">) {
  if (item.state === "NEEDS_INFO" || item.state === "DISPUTED") return "Answer";
  if (item.type === "SHARED_ALLOCATION") return "Choose";
  if (item.discrepancyCents > 0) return "Dispute";
  return "Approve";
}

/* ------------------------------------------------------------ splits */

function splitFromProposal(p: Proposal, order: string[], projects: WorkspaceData["projects"]): Segment[] {
  return p.payload.allocation
    .filter((l) => l.amountCents > 0)
    .map((l) => ({ key: l.projectId, label: projects[l.projectId]?.name ?? l.projectId, value: l.amountCents, tone: projectTone(l.projectId, order) }));
}

/** Recomputes a reservation split under another method from recorded usage. */
function splitFor(method: string, w: WorkspaceData, total: number, order: string[]): Segment[] | null {
  const u = w.reservationUsage;
  const owner = w.reservation?.ownerProjectId;
  if (!u || !owner || !u.reservedGpuHours) return null;
  const perHour = total / u.reservedGpuHours;
  const name = (id: string) => w.projects[id]?.name ?? id;
  let lines: { id: string; cents: number }[];
  if (method === "owner_pays_idle") {
    lines = u.usageByProject.map((p) => ({ id: p.projectId, cents: Math.round(p.gpuHours * perHour) }));
    const o = lines.find((l) => l.id === owner);
    if (o) o.cents += Math.round(u.idleGpuHours * perHour);
    else lines.push({ id: owner, cents: Math.round(u.idleGpuHours * perHour) });
  } else if (method === "usage_proportional") {
    const used = u.usedGpuHours || 1;
    lines = u.usageByProject.map((p) => ({ id: p.projectId, cents: Math.round((p.gpuHours / used) * total) }));
  } else if (method === "owner_pays_all") {
    lines = [{ id: owner, cents: total }];
  } else return null;
  // Rounding lands on the largest line so the split always sums to the charge.
  const diff = total - lines.reduce((s, l) => s + l.cents, 0);
  if (diff && lines.length) lines.sort((a, b) => b.cents - a.cents)[0].cents += diff;
  return lines
    .filter((l) => l.cents > 0)
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    .map((l) => ({ key: l.id, label: name(l.id), value: l.cents, tone: projectTone(l.id, order) }));
}

const METHOD_SHORT: Record<string, string> = {
  usage_proportional: "By usage",
  owner_pays_idle: "Idle to owner",
  owner_pays_all: "All to owner",
  single_owner: "One owner",
  undisputed_to_owner: "Supported amount to owner",
};

const METHOD_RULE: Record<string, string> = {
  usage_proportional: "Split shared reservations by hours used",
  owner_pays_idle: "Idle reserved hours go to the team that reserved them",
  owner_pays_all: "The reserving team pays for the whole reservation",
};

/* ------------------------------------------------------------ builder */

function flagLines(checks: InstanceChecks | ReservationChecks, max = 3) {
  const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  const duplicate = checks.flags.some((f) => f.code === "DUPLICATE_CHARGE");
  return [...checks.flags]
    .filter((f) => f.code !== "AMOUNT_VARIANCE" && !(duplicate && f.code === "QUANTITY_EXCEEDS_LIFECYCLE"))
    .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))
    .slice(0, max)
    .map((f) => f.message);
}

function disputeDecision(w: WorkspaceData, approvalId: string, p: Proposal): Decision {
  const d = p.payload.dispute!;
  const c = w.item.checks as InstanceChecks;
  const prov = providerName(w, w.item.providerId);
  const billedHours = (c.priorBilledHours ?? 0) + c.billedHours;
  let title = prov + " overbilled " + whole(d.disputedCents);
  let proof: Proof | null = null;
  if (c.priorBilledHours) {
    title = prov + " billed the same hours twice";
    proof = { kind: "compare", unit: "h", billed: { label: "Billed", value: billedHours }, owed: { label: "Ran", value: c.billableHours } };
  } else if (c.invoicedRateCents > c.contractRateCents) {
    title = prov + " charged above the contract rate";
    proof = {
      kind: "compare",
      unit: "$/h",
      billed: { label: "Charged", value: c.invoicedRateCents },
      owed: { label: "Contract", value: c.contractRateCents },
    };
  } else if (c.billedHours > c.billableHours) {
    title = prov + " billed " + h(c.billedHours - c.billableHours) + " h after shutdown";
    proof = { kind: "compare", unit: "h", billed: { label: "Billed", value: c.billedHours }, owed: { label: "Ran", value: c.billableHours } };
  }
  if (!proof) proof = { kind: "compare", unit: "$", billed: { label: "Billed", value: d.invoicedCents }, owed: { label: "Owed", value: d.undisputedCents } };
  return {
    kind: "dispute",
    approvalId,
    askedBy: p.createdBy,
    context: prov + " · " + (w.item.instanceId ?? w.item.reservationId ?? w.item.id),
    title,
    ask: whole(d.invoicedCents) + " billed, " + whole(d.undisputedCents) + " owed",
    proof,
    choices: [
      {
        id: "dispute",
        label: "Dispute " + whole(d.disputedCents),
        hint: d.undisputedCents ? "pay " + whole(d.undisputedCents) + " now" : undefined,
        primary: true,
        action: { type: "approve" },
      },
      {
        id: "pay",
        label: "Pay in full",
        hint: whole(d.invoicedCents),
        action: { type: "reject", reason: "Pay the invoice in full; do not dispute this charge." },
      },
    ],
    why: flagLines(c),
    custom: "changes",
  };
}

function bookDecision(w: WorkspaceData, approvalId: string, p: Proposal): Decision {
  const c = w.item.checks as InstanceChecks;
  const prov = providerName(w, w.item.providerId);
  const lines = p.payload.allocation.filter((l) => l.amountCents > 0);
  const who = lines.length === 1 ? (w.projects[lines[0].projectId]?.name ?? lines[0].projectId) : lines.length + " teams";
  const limit = w.policies.find((x) => x.status === "APPROVED" && x.policyKey !== "ALLOC-SHARED")?.rule.autoPostLimitCents;
  let ask = "Needs your sign-off";
  let marker: { label: string; value: number } | undefined;
  if (w.item.discrepancyCents < 0) ask = "Billed " + whole(-w.item.discrepancyCents) + " under contract";
  else if (limit && p.payload.totalCents > limit) {
    ask = "Over your " + money(limit, { cents: false }) + " auto-approve limit";
    marker = { label: "Limit", value: limit };
  }
  return {
    kind: "book",
    approvalId,
    askedBy: p.createdBy,
    context: prov + " · " + (w.item.instanceId ?? w.item.reservationId ?? w.item.id),
    title: "Book " + whole(p.payload.totalCents) + " to " + who,
    ask,
    proof: {
      kind: "compare",
      unit: "$",
      billed: { label: "Billed", value: w.item.invoicedCents },
      owed: { label: "Contract", value: c.expectedCents ?? w.item.expectedCents },
      marker,
    },
    choices: [{ id: "approve", label: "Approve", hint: "posts to the ledger", primary: true, action: { type: "approve" } }],
    why: c.flags ? flagLines(c) : [],
    custom: "changes",
  };
}

function splitDecision(w: WorkspaceData, approvalId: string, p: Proposal): Decision {
  const c = w.item.checks as ReservationChecks;
  const prov = providerName(w, w.item.providerId);
  const order = [w.reservation?.ownerProjectId ?? "", ...c.usageByProject.map((u) => u.projectId)].filter((v, i, a) => v && a.indexOf(v) === i);
  const total = p.payload.totalCents;
  const ownerIdle = Boolean(w.reservation?.ownerAccountableForIdle);
  const contractMethod = ownerIdle ? "owner_pays_idle" : "usage_proportional";
  const policyMethod = w.policyFit?.policy?.rule.method ?? null;
  const conflict = policyMethod !== null && policyMethod !== contractMethod;
  const tagFor = (m: string) => (m === contractMethod ? "Matches contract" : m === policyMethod ? "Current policy" : undefined);
  // The two options are always usage-based and idle-to-owner, so the contract's method is one of them.
  const recommended = contractMethod;
  const alternatives = (["owner_pays_idle", "usage_proportional"] as const).filter((m) => m !== p.method);
  const choices: Choice[] = [
    {
      id: "proposed",
      label: METHOD_SHORT[p.method] ?? p.method,
      tag: tagFor(p.method),
      primary: recommended === p.method,
      split: splitFromProposal(p, order, w.projects),
      action: { type: "approve" },
    },
  ];
  for (const m of alternatives.slice(0, 1)) {
    const split = splitFor(m, w, total, order);
    if (!split) continue;
    choices.push({
      id: m,
      label: METHOD_SHORT[m],
      tag: tagFor(m),
      primary: recommended === m,
      split,
      action: {
        type: "changes",
        directive: m,
        reason:
          m === "owner_pays_idle"
            ? "Follow the reservation terms: usage to each team, idle reserved capacity to the reserving team."
            : "Split the reservation in proportion to GPU-hours used.",
      },
    });
  }
  const owner = w.reservation ? (w.projects[w.reservation.ownerProjectId]?.name ?? w.reservation.ownerProjectId) : "";
  return {
    kind: "split",
    approvalId,
    askedBy: p.createdBy,
    context: prov + " · " + (w.item.reservationId ?? w.item.id),
    title: "How should " + whole(total) + " be split?",
    ask: conflict
      ? "Policy and contract disagree on idle hours"
      : p.method === contractMethod
        ? "Follows the contract and your rule"
        : "Needs your sign-off",
    proof: w.reservationUsage
      ? {
          kind: "usage",
          reserved: w.reservationUsage.reservedGpuHours,
          ownerKey: w.reservation?.ownerProjectId ?? "",
          segments: [
            ...w.reservationUsage.usageByProject.map((u) => ({
              key: u.projectId,
              label: w.projects[u.projectId]?.name ?? u.projectId,
              value: u.gpuHours,
              tone: projectTone(u.projectId, order),
            })),
            { key: "idle", label: "Idle", value: w.reservationUsage.idleGpuHours, tone: "idle" as const },
          ],
        }
      : null,
    choices,
    why: [
      ...(owner && ownerIdle ? [owner + " reserved it and agreed to cover unused hours."] : []),
      ...flagLines(c, 1),
      ...(w.policyFit?.fit.conflicts ?? []).slice(0, 1),
    ].slice(0, 3),
    custom: "changes",
  };
}

function ruleDecision(w: WorkspaceData, approval: WorkspaceData["approvals"][number]): Decision | null {
  const policy = w.policies.find((x) => x.id === approval.subjectId);
  if (!policy) return null;
  const current = w.policies.find((x) => x.policyKey === policy.policyKey && x.status === "APPROVED");
  return {
    kind: "rule",
    approvalId: approval.id,
    askedBy: approval.requestedBy,
    context: w.approvals.some((a) => a.subjectType === "PROPOSAL" && (a.status === "REJECTED" || a.status === "CHANGES_REQUESTED")) ? "Learned from your correction" : "Learned from your note",
    title: METHOD_RULE[policy.rule.method] ?? policy.title,
    ask: "Make this the rule from now on?",
    proof: null,
    choices: [
      {
        id: "adopt",
        label: "Make it the rule",
        hint: "auto-books up to " + money(policy.rule.autoPostLimitCents, { cents: false }),
        primary: true,
        action: { type: "approve" },
      },
      { id: "later", label: "Not yet", hint: "keep asking me", action: { type: "reject", reason: "Keep reviewing these case by case for now." } },
    ],
    why: [
      ...(current ? ["Replaces: " + (METHOD_RULE[current.rule.method] ?? current.title).toLowerCase() + "."] : []),
      ...policy.rule.conditions.slice(0, 2),
    ],
    custom: null,
  };
}

function ownerDecision(w: WorkspaceData): Decision | null {
  const q = w.item.pendingQuestion;
  if (!q) return null;
  const m = q.question.match(/(exp-[\w-]+)\s*\('([^']+)'\)/);
  const prov = providerName(w, w.item.providerId);
  const projects = Object.values(w.projects);
  return {
    kind: "owner",
    approvalId: null,
    askedBy: q.askedBy ?? q.agentId,
    context: prov + " · " + (w.item.instanceId ?? w.item.id),
    title: "Whose " + whole(w.item.invoicedCents) + " charge is this?",
    ask: m ? m[2] + " has no project tag" : "No project owns this run",
    proof: null,
    choices: projects.map((p) => ({ id: p.id, label: p.name, hint: p.lead, action: { type: "answer", answer: p.id + " (" + p.name + ")" } })),
    why: [q.question],
    custom: "answer",
  };
}

const dollars = (cents: number) => "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** The Vendor Liaison needs you to decide how to answer the vendor (an offer, or a question only xAnthropenAI can answer). */
function vendorDecision(w: WorkspaceData): Decision | null {
  const q = w.item.pendingQuestion;
  if (!q || !w.dispute) return null;
  const msg = [...w.vendorMessages].reverse().find((m) => m.direction === "inbound" && m.status === "waiting_on_controller");
  const disputed = w.dispute.amountCents;
  const offered = msg
    ? [...msg.body.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)].map((m) => Math.round(Number(m[1].replace(/,/g, "")) * 100)).filter((c) => c > 0 && c < disputed)
    : [];
  const prov = providerName(w, w.item.providerId);
  const offer = offered[0];
  return {
    kind: "vendor",
    approvalId: null,
    askedBy: q.askedBy ?? q.agentId,
    context: prov + " · " + w.dispute.id,
    title: offer ? prov + " offers " + dollars(offer) + " of " + dollars(disputed) : prov + " needs something from xAnthropenAI",
    ask: msg ? "\u201c" + msg.body.replace(/\s+/g, " ").slice(0, 180) + (msg.body.length > 180 ? "\u2026\u201d" : "\u201d") : q.question,
    proof: null,
    choices: offer
      ? [
          { id: "accept", label: "Accept " + dollars(offer), hint: "close the case", action: { type: "answer", answer: "Yes, accept the " + dollars(offer) + " credit and close it." } },
          { id: "hold", label: "Hold out for " + dollars(disputed), hint: "reply with the evidence", action: { type: "answer", answer: "No, decline the offer and hold out for the full " + dollars(disputed) + "." } },
        ]
      : [],
    why: [q.question],
    custom: "answer",
  };
}

/** The decision waiting on you for this task, or null when nothing is. */
export function buildDecision(w: WorkspaceData): Decision | null {
  if (w.item.state === "NEEDS_INFO") return ownerDecision(w);
  if (w.item.state === "DISPUTED" && w.item.pendingQuestion) return vendorDecision(w);
  const approval = w.approvals.find((a) => a.status === "PENDING");
  if (!approval) return null;
  if (approval.subjectType === "POLICY") return ruleDecision(w, approval);
  const p = w.proposals.find((x) => x.id === approval.subjectId);
  if (!p) return null;
  if (p.kind === "VENDOR_DISPUTE" && p.payload.dispute) return disputeDecision(w, approval.id, p);
  if (w.item.type === "SHARED_ALLOCATION") return splitDecision(w, approval.id, p);
  return bookDecision(w, approval.id, p);
}

/* ------------------------------------------------------------ outcomes */

export type Outcome = { title: string; detail: string | null; tone: "done" | "vendor" | "working" | "waiting" };

/** One line for a task that does not need you: what happened or what is happening. */
export function outcomeOf(w: WorkspaceData): Outcome {
  const executed = [...w.proposals].reverse().find((p) => p.status === "EXECUTED" || p.status === "APPROVED");
  const prov = providerName(w, w.item.providerId);
  if (w.item.state === "DISPUTED" && w.dispute) {
    const replied = w.vendorMessages.some((m) => m.direction === "inbound" && m.status === "new");
    return { title: "Disputed " + whole(w.dispute.amountCents) + " with " + prov, detail: replied ? prov + " replied; Vendor Liaison is on it" : "Waiting for a credit", tone: "vendor" };
  }
  if (w.item.state === "RESOLVED" || w.item.state === "POSTED") {
    if (executed?.kind === "VENDOR_DISPUTE" && executed.payload.dispute) {
      const d = w.dispute;
      if (d?.status === "DENIED") {
        return { title: prov + " refused the " + whole(d.amountCents) + " credit", detail: "Charged to the owning team", tone: "done" };
      }
      if (d?.creditedCents != null && d.creditedCents < d.amountCents) {
        return { title: prov + " credited " + whole(d.creditedCents) + " of " + whole(d.amountCents), detail: "You accepted their offer", tone: "done" };
      }
      return {
        title: prov + " credited " + whole(executed.payload.dispute.disputedCents),
        detail: "Booked " + whole(executed.payload.dispute.undisputedCents),
        tone: "done",
      };
    }
    if (executed) {
      const lines = executed.payload.allocation.filter((l) => l.amountCents > 0);
      const to = lines.length === 1 ? (w.projects[lines[0].projectId]?.name ?? lines[0].projectId) : lines.length + " teams";
      return {
        title: "Booked " + whole(executed.payload.totalCents) + " to " + to,
        detail: executed.authorization?.startsWith("Standing") ? "Under standing policy" : "Approved by you",
        tone: "done",
      };
    }
    return { title: "Matched the contract", detail: "Booked automatically", tone: "done" };
  }
  return { title: "Agents are on it", detail: null, tone: "working" };
}

