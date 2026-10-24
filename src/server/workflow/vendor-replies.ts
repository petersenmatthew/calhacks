import { and, asc, eq, inArray } from "drizzle-orm";
import { recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { CONTROLLER } from "../comms/directory";
import { dmSlack, mention, postSlack, queueEmail, taskLink } from "../comms/outbox";
import { nextId, nowIso, tx, type AppContext } from "../context";
import { findings, jobs, outbox, providers, vendorDisputes, vendorMessages, workItems } from "../db/schema";
import { formatCents } from "../domain/money";
import { ACTOR, getActor } from "../security/actors";
import { ControlError } from "../security/errors";
import { closeDispute, renderLetterHtml } from "./decisions";
import { renderEvidenceCsv } from "./dispute-evidence";
import { followUpsFor } from "./follow-ups";
import { enqueueJob } from "./jobs";
import { assignAgent, getWorkItem, type WorkItemRow } from "./work-items";

/*
 * The vendor's side of the conversation. Replies arrive from the AP mailbox
 * (see comms/inbox.ts) or are pasted in by hand, are matched to their dispute,
 * stored, and handed to the Vendor Liaison, who answers questions, books a
 * credit or denial, or asks the controller when the vendor proposes something
 * the approval does not cover (a partial credit, say).
 */

export type DisputeRow = typeof vendorDisputes.$inferSelect;
export type VendorMessageRow = typeof vendorMessages.$inferSelect;

export interface InboundEmail {
  from: string | null;
  to?: string | null;
  subject: string;
  text: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  receivedAt?: string;
}

/** Drop the quoted original that mail clients append under a reply. */
export function stripQuoted(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? "";
    // "On Fri, Oct 24, 2026 at 9:14 AM Atlas <ap@...> wrote:" (sometimes wrapped over two lines)
    if (/^On .+wrote:\s*$/.test(line) || (/^On .+/.test(line) && /wrote:\s*$/.test(next))) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^_{5,}$/.test(line) && /^From:/i.test(next)) break;
    if (/^>/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
}

/** Dollar amounts written in a message, in cents. */
export function amountsIn(text: string) {
  return [...text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)].map((m) => Math.round(Number(m[1].replace(/,/g, "")) * 100));
}

/** Which dispute an inbound email is about: by email thread first, then by the case reference in the subject or body. */
export function matchDispute(ctx: AppContext, m: InboundEmail): DisputeRow | null {
  const ids = [m.inReplyTo, ...(m.references ?? [])].filter((x): x is string => Boolean(x));
  if (ids.length) {
    const sent = ctx.db.select().from(outbox).where(and(eq(outbox.channel, "email"), inArray(outbox.providerMessageId, ids))).all();
    for (const row of sent) {
      if (!row.ref) continue;
      const d = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.id, row.ref)).get();
      if (d) return d;
    }
  }
  const hay = m.subject + "\n" + m.text;
  const all = ctx.db.select().from(vendorDisputes).all();
  for (const ref of hay.match(/\b[A-Z0-9]+-CASE-\d+\b/gi) ?? []) {
    const up = ref.toUpperCase();
    const d = all.find((x) => x.vendorReference?.toUpperCase() === up || (x.letterSubject ?? "").toUpperCase().includes(up));
    if (d) return d;
  }
  for (const ref of hay.match(/DSP-\d+/gi) ?? []) {
    const d = all.find((x) => x.id === ref.toUpperCase());
    if (d) return d;
  }
  return null;
}

function providerName(ctx: AppContext, id: string) {
  return ctx.db.select().from(providers).where(eq(providers.id, id)).get()?.name ?? "The vendor";
}

function snippet(text: string, n = 220) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** A liaison run for this item is already queued, so it will see the new message anyway. (A running one may have read the thread already.) */
function liaisonBusy(ctx: AppContext, workItemId: string) {
  return ctx.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.workItemId, workItemId), eq(jobs.agentId, ACTOR.vendorLiaison), eq(jobs.status, "queued")))
    .all().length > 0;
}

export type ReceiveResult =
  | { status: "duplicate"; id: string }
  | { status: "unmatched" }
  | { status: "recorded"; id: string; disputeId: string; workItemId: string; routed: boolean };

/** Store a vendor email against its dispute and, if the case is still open, put the Vendor Liaison on it. */
export function receiveVendorEmail(ctx: AppContext, m: InboundEmail): ReceiveResult {
  if (m.messageId) {
    const dup = ctx.db.select().from(vendorMessages).where(eq(vendorMessages.messageId, m.messageId)).get();
    if (dup) return { status: "duplicate", id: dup.id };
  }
  const dispute = matchDispute(ctx, m);
  if (!dispute) return { status: "unmatched" };
  // A reply cannot predate the letter it answers (guards against old mail after a demo reset reuses case numbers).
  if (m.receivedAt && new Date(m.receivedAt).getTime() < new Date(dispute.submittedAt).getTime() - 5 * 60_000) return { status: "unmatched" };
  const body = stripQuoted(m.text) || m.text.trim().slice(0, 4000);
  if (!body) return { status: "unmatched" };
  const item = getWorkItem(ctx, dispute.workItemId);
  const vendor = providerName(ctx, dispute.providerId);
  const open = item.state === "DISPUTED" && dispute.status === "SUBMITTED";
  return tx(ctx, () => {
    const id = nextId(ctx, "VM", 7001);
    ctx.db
      .insert(vendorMessages)
      .values({
        id,
        disputeId: dispute.id,
        workItemId: item.id,
        direction: "inbound",
        fromAddr: m.from,
        toAddr: m.to ?? null,
        subject: m.subject.slice(0, 300),
        body,
        messageId: m.messageId ?? null,
        inReplyTo: m.inReplyTo ?? null,
        status: open ? "new" : "ignored",
        receivedAt: m.receivedAt ?? nowIso(),
      })
      .run();
    appendAudit(ctx, {
      actorId: ACTOR.vendor,
      action: "vendor.message",
      category: "write",
      targetType: "vendor_dispute",
      targetId: dispute.id,
      workItemId: item.id,
      details: { messageId: id, from: m.from, subject: m.subject.slice(0, 300) },
    });
    recordActivity(ctx, {
      workItemId: item.id,
      actorId: ACTOR.vendor,
      type: "DISPUTE",
      status: "info",
      title: vendor + " replied on " + dispute.id + (m.from ? " (" + m.from + ")" : ""),
      summary: snippet(body, 600),
      changes: ["Vendor message " + id],
    });
    let routed = false;
    if (open) {
      postSlack(ctx, {
        channel: "vendor-disputes",
        event: "dispute.vendor_message",
        workItemId: item.id,
        ref: dispute.id,
        text: vendor + " replied on " + dispute.id + " (" + taskLink(ctx, item.id) + "): “" + snippet(body) + "” Vendor Liaison is on it.",
      });
      if (!liaisonBusy(ctx, item.id)) {
        assignAgent(ctx, item.id, ACTOR.vendorLiaison);
        enqueueJob(ctx, { workItemId: item.id, kind: "AGENT_RUN", agentId: ACTOR.vendorLiaison, payload: { trigger: "vendor_message", messageId: id } });
      }
      routed = true;
    } else {
      postSlack(ctx, {
        channel: "vendor-disputes",
        event: "dispute.vendor_message",
        workItemId: item.id,
        ref: dispute.id,
        mentions: [CONTROLLER],
        text:
          mention(CONTROLLER) + " " + vendor + " wrote about " + dispute.id + ", which is already closed (" + taskLink(ctx, item.id) + "): “" + snippet(body) + "”",
      });
    }
    return { status: "recorded" as const, id, disputeId: dispute.id, workItemId: item.id, routed };
  });
}

/** The whole conversation on a dispute, oldest first: our letter, follow-ups, vendor replies, our answers. */
export function disputeThread(ctx: AppContext, dispute: DisputeRow) {
  const entries: {
    id: string;
    at: string;
    direction: "inbound" | "outbound";
    from: string | null;
    subject: string | null;
    body: string;
    status: string;
    kind: string | null;
  }[] = [];
  if (dispute.letterBody) {
    entries.push({
      id: dispute.id,
      at: dispute.submittedAt,
      direction: "outbound",
      from: "Atlas Research AP",
      subject: dispute.letterSubject,
      body: dispute.letterBody.split("\n\nEVIDENCE\n")[0],
      status: "sent",
      kind: "dispute_letter",
    });
  }
  for (const f of followUpsFor(ctx, dispute.id).filter((x) => x.kind === "VENDOR_MESSAGE")) {
    const d = f.details as { message?: string; subject?: string };
    entries.push({ id: f.key, at: f.createdAt, direction: "outbound", from: "Vendor Liaison", subject: d.subject ?? null, body: d.message ?? "", status: "sent", kind: "follow_up" });
  }
  for (const m of messagesFor(ctx, dispute.id)) {
    entries.push({
      id: m.id,
      at: m.receivedAt,
      direction: m.direction as "inbound" | "outbound",
      from: m.direction === "inbound" ? m.fromAddr : "Vendor Liaison",
      subject: m.subject,
      body: m.body,
      status: m.status,
      kind: m.kind,
    });
  }
  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export function messagesFor(ctx: AppContext, disputeId: string) {
  return ctx.db.select().from(vendorMessages).where(eq(vendorMessages.disputeId, disputeId)).orderBy(asc(vendorMessages.receivedAt)).all();
}

export function unansweredFor(ctx: AppContext, disputeId: string) {
  return messagesFor(ctx, disputeId).filter((m) => m.direction === "inbound" && (m.status === "new" || m.status === "waiting_on_controller"));
}

function inboundMessage(ctx: AppContext, dispute: DisputeRow, messageId: string) {
  const m = ctx.db.select().from(vendorMessages).where(eq(vendorMessages.id, messageId)).get();
  if (!m || m.disputeId !== dispute.id || m.direction !== "inbound") {
    throw new ControlError("Message " + messageId + " is not a vendor reply on " + dispute.id + ".", "NOT_FOUND", "FAILED");
  }
  return m;
}

function markHandled(ctx: AppContext, ids: string[], status: string, agentId: string, kind: string) {
  if (!ids.length) return;
  ctx.db.update(vendorMessages).set({ status, kind, handledBy: agentId, handledAt: nowIso() }).where(inArray(vendorMessages.id, ids)).run();
}

export function disputeFor(ctx: AppContext, item: WorkItemRow) {
  const d = ctx.db.select().from(vendorDisputes).where(eq(vendorDisputes.workItemId, item.id)).get();
  if (!d) throw new ControlError("There is no vendor dispute on " + item.id + ".", "NOT_FOUND", "FAILED");
  return d;
}

/** The controller's answers on this item that came after the vendor message they were asked about. */
function controllerAnswers(ctx: AppContext, item: WorkItemRow) {
  return ctx.db
    .select()
    .from(findings)
    .where(and(eq(findings.workItemId, item.id), eq(findings.kind, "human")))
    .orderBy(asc(findings.createdAt))
    .all();
}

/**
 * Amounts the liaison may put in writing to the vendor: those already in the
 * approved letter and its evidence, plus any amount the controller named or
 * an offer the controller has answered on since the vendor made it.
 */
export function quotableAmounts(ctx: AppContext, item: WorkItemRow, dispute: DisputeRow) {
  const allowed = new Set([dispute.amountCents, ...amountsIn(dispute.letterBody ?? "")]);
  const answers = controllerAnswers(ctx, item);
  for (const a of answers) for (const c of amountsIn(a.summary)) allowed.add(c);
  const lastAnswer = answers[answers.length - 1]?.createdAt;
  if (lastAnswer) {
    for (const m of messagesFor(ctx, dispute.id)) {
      if (m.direction === "inbound" && m.status === "waiting_on_controller" && (m.handledAt ?? m.receivedAt) <= lastAnswer) for (const c of amountsIn(m.body)) allowed.add(c);
    }
  }
  return allowed;
}

/** Queue an email to the vendor in the dispute's thread and keep a copy in the conversation. */
function sendInThread(
  ctx: AppContext,
  item: WorkItemRow,
  dispute: DisputeRow,
  input: { agentId: string; answering: VendorMessageRow[]; text: string; attachEvidence: boolean; kind: string },
) {
  const last = input.answering[input.answering.length - 1] ?? messagesFor(ctx, dispute.id).filter((m) => m.direction === "inbound").pop();
  const to = last?.fromAddr || dispute.sentTo || "";
  const baseSubject = (last?.subject || dispute.letterSubject || "[" + dispute.vendorReference + "] Billing dispute " + dispute.id).replace(/^(re:\s*)+/i, "");
  const subject = "Re: " + baseSubject;
  const body = input.text.trim() + "\n\nReference: " + (dispute.letterSubject?.match(/\b[A-Z0-9]+-CASE-\d+\b/)?.[0] ?? dispute.vendorReference) + " (dispute " + dispute.id + ", " + formatCents(dispute.amountCents) + ").";
  const threadIds = [
    ...ctx.db
      .select({ id: outbox.providerMessageId })
      .from(outbox)
      .where(and(eq(outbox.channel, "email"), eq(outbox.ref, dispute.id)))
      .all()
      .map((r) => r.id),
    ...messagesFor(ctx, dispute.id).map((m) => m.messageId),
  ].filter((x): x is string => Boolean(x && x.startsWith("<")));
  const headers: Record<string, string> = {};
  if (last?.messageId) headers["In-Reply-To"] = last.messageId;
  if (threadIds.length) headers["References"] = [...new Set(threadIds)].join(" ");
  const id = nextId(ctx, "VM", 7001);
  ctx.db
    .insert(vendorMessages)
    .values({
      id,
      disputeId: dispute.id,
      workItemId: item.id,
      direction: "outbound",
      fromAddr: null,
      toAddr: to,
      subject,
      body,
      status: "sent",
      kind: input.kind,
      handledBy: input.agentId,
      handledAt: nowIso(),
      receivedAt: nowIso(),
    })
    .run();
  queueEmail(ctx, {
    to,
    subject,
    text: body,
    html: renderLetterHtml(body),
    event: "dispute.reply_sent",
    workItemId: item.id,
    ref: dispute.id,
    headers,
    attachments:
      input.attachEvidence && dispute.evidence
        ? [{ filename: dispute.id + "-evidence.csv", content: renderEvidenceCsv(dispute.evidence as never), contentType: "text/csv" }]
        : [],
  });
  return { id, to, subject };
}

function checkQuotable(ctx: AppContext, item: WorkItemRow, dispute: DisputeRow, text: string) {
  const allowed = quotableAmounts(ctx, item, dispute);
  const stray = amountsIn(text).filter((c) => !allowed.has(c));
  if (stray.length) {
    throw new ControlError(
      "The message mentions " + stray.map(formatCents).join(", ") + ", which is not in the approved dispute. Only the controller can agree to a different amount; use ask_controller.",
      "APPROVAL_REQUIRED",
      "FAILED",
    );
  }
}

/** Email the vendor in the same thread. Never commits Atlas to an amount the controller did not approve. */
export function replyToVendor(
  ctx: AppContext,
  item: WorkItemRow,
  input: { agentId: string; answering: string[]; text: string; attachEvidence: boolean; kind: string },
) {
  const dispute = disputeFor(ctx, item);
  if (dispute.status !== "SUBMITTED" || item.state !== "DISPUTED") {
    throw new ControlError("Dispute " + dispute.id + " is " + dispute.status + "; there is nothing open to answer.", "STATE_MACHINE", "FAILED");
  }
  if (item.pendingQuestion) throw new ControlError("Wait for the controller to answer your open question first.", "STATE_MACHINE", "FAILED");
  const answering = input.answering.map((id) => inboundMessage(ctx, dispute, id));
  checkQuotable(ctx, item, dispute, input.text);
  const sent = sendInThread(ctx, item, dispute, { ...input, answering });
  markHandled(
    ctx,
    answering.map((m) => m.id),
    "handled",
    input.agentId,
    input.kind,
  );
  postSlack(ctx, {
    channel: "vendor-disputes",
    event: "dispute.reply_sent",
    workItemId: item.id,
    ref: dispute.id,
    text: "Vendor Liaison answered " + providerName(ctx, dispute.providerId) + " on " + dispute.id + " (" + taskLink(ctx, item.id) + "): \u201c" + snippet(input.text) + "\u201d",
  });
  return { ...sent, dispute };
}

export type VendorDecision = "credited" | "partial_credit" | "denied";

/**
 * Book what the vendor decided, citing the message that says so, and close the case.
 * A full credit or a refusal is the vendor's call; a partial credit needs the controller's answer first.
 */
export function recordVendorDecision(
  ctx: AppContext,
  item: WorkItemRow,
  input: { agentId: string; messageId: string; decision: VendorDecision; creditReference?: string | null; creditCents?: number | null; confirmation?: string | null },
) {
  const dispute = disputeFor(ctx, item);
  if (dispute.status !== "SUBMITTED" || item.state !== "DISPUTED") {
    throw new ControlError("Dispute " + dispute.id + " is already " + dispute.status + ".", "STATE_MACHINE", "FAILED");
  }
  if (item.pendingQuestion) throw new ControlError("Wait for the controller to answer your open question first.", "STATE_MACHINE", "FAILED");
  const msg = inboundMessage(ctx, dispute, input.messageId);
  const amounts = amountsIn(msg.body);
  let creditedCents: number | null = null;
  if (input.decision === "credited" && amounts.length && !amounts.includes(dispute.amountCents)) {
    throw new ControlError(
      "The vendor's message mentions " + amounts.map(formatCents).join(", ") + ", not the disputed " + formatCents(dispute.amountCents) +
        ". A partial credit needs the controller; use ask_controller.",
      "APPROVAL_REQUIRED",
      "FAILED",
    );
  }
  if (input.decision === "partial_credit") {
    creditedCents = Math.round(input.creditCents ?? 0);
    if (!(creditedCents > 0 && creditedCents < dispute.amountCents)) {
      throw new ControlError("A partial credit must be more than $0.00 and less than " + formatCents(dispute.amountCents) + ".", "ARITHMETIC_CHECK", "FAILED");
    }
    // The controller must have answered after this offer, without turning it down, and the amount must be the offer (or one the controller named).
    // Ordered by when the question was asked (handledAt), not the email's Date header, which can be skewed.
    const asked = msg.handledAt ?? msg.receivedAt;
    const answer = controllerAnswers(ctx, item).filter((a) => a.createdAt >= asked).pop();
    const declined = answer ? /\b(no|reject|decline|don'?t|do not|refuse|hold out|push back)\b/i.test(answer.summary) : true;
    const amountOk = answer ? [...amountsIn(msg.body), ...amountsIn(answer.summary)].includes(creditedCents) : false;
    if (msg.status !== "waiting_on_controller" || !answer || declined || !amountOk) {
      throw new ControlError("Accepting " + formatCents(creditedCents) + " instead of " + formatCents(dispute.amountCents) + " needs the controller's answer; use ask_controller.", "APPROVAL_REQUIRED", "FAILED");
    }
  }
  if (input.confirmation?.trim()) {
    checkQuotable(ctx, item, dispute, input.confirmation);
    sendInThread(ctx, item, dispute, { agentId: input.agentId, answering: [msg], text: input.confirmation.trim().slice(0, 2000), attachEvidence: false, kind: "confirmation" });
  }
  const reference =
    (input.creditReference ?? "").trim().slice(0, 60) || msg.body.match(/\b(?:CM|CR|CN)[-\s#]?\d{2,}\b/i)?.[0] || "CM-" + dispute.id.split("-")[1];
  ctx.db
    .update(vendorDisputes)
    .set(
      input.decision === "denied"
        ? { status: "DENIED", resolvedAt: nowIso() }
        : { status: "CREDIT_ACCEPTED", vendorReference: reference, creditedCents, resolvedAt: nowIso() },
    )
    .where(eq(vendorDisputes.id, dispute.id))
    .run();
  markHandled(
    ctx,
    unansweredFor(ctx, dispute.id).map((m) => m.id),
    "handled",
    input.agentId,
    input.decision === "denied" ? "denial" : input.decision === "partial_credit" ? "counter_offer" : "credit",
  );
  const fresh = ctx.db.select().from(workItems).where(eq(workItems.id, item.id)).get()!;
  return closeDispute(ctx, fresh as WorkItemRow);
}

/** The vendor proposed something outside the approval, or asked for something only the controller knows. */
export function askControllerAboutVendor(
  ctx: AppContext,
  item: WorkItemRow,
  input: { agentId: string; messageId: string; question: string; recommendation: string; kind: string },
) {
  const dispute = disputeFor(ctx, item);
  if (item.state !== "DISPUTED") throw new ControlError("Work item is " + item.state + ".", "STATE_MACHINE", "FAILED");
  if (item.pendingQuestion) throw new ControlError("A question to the controller is already open on " + item.id + ".", "STATE_MACHINE", "FAILED");
  const msg = inboundMessage(ctx, dispute, input.messageId);
  const vendor = providerName(ctx, dispute.providerId);
  const question = (input.question.trim() + (input.recommendation.trim() ? " Recommended: " + input.recommendation.trim() : "")).slice(0, 700);
  ctx.db
    .update(workItems)
    .set({ pendingQuestion: { agentId: input.agentId, question, askedBy: input.agentId } })
    .where(eq(workItems.id, item.id))
    .run();
  markHandled(ctx, [msg.id], "waiting_on_controller", input.agentId, input.kind);
  postSlack(ctx, {
    channel: "vendor-disputes",
    event: "dispute.controller_question",
    workItemId: item.id,
    ref: dispute.id,
    mentions: [CONTROLLER],
    text: mention(CONTROLLER) + " " + vendor + " replied on " + dispute.id + " and the Vendor Liaison needs you (" + taskLink(ctx, item.id) + "): " + question,
  });
  dmSlack(ctx, {
    to: CONTROLLER,
    event: "dispute.controller_question",
    workItemId: item.id,
    ref: dispute.id,
    text: vendor + " wrote: “" + snippet(msg.body, 300) + "”\n" + question + "\nAnswer here: " + taskLink(ctx, item.id),
  });
  return { question, dispute, askedBy: getActor(ctx, input.agentId)?.name ?? input.agentId };
}

/** The vendor's note needs no answer (an acknowledgement, "we're reviewing it"). Record it and wait. */
export function noteVendorUpdate(ctx: AppContext, item: WorkItemRow, input: { agentId: string; messageId: string }) {
  const dispute = disputeFor(ctx, item);
  const msg = inboundMessage(ctx, dispute, input.messageId);
  markHandled(ctx, [msg.id], "handled", input.agentId, "update");
  return { dispute, message: msg };
}
