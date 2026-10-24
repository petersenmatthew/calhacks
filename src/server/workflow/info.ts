import { eq } from "drizzle-orm";
import { recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { nextId, nowIso, type AppContext } from "../context";
import { evidence, findings, workItems } from "../db/schema";
import { getActor } from "../security/actors";
import { authorize, guard } from "../security/authorize";
import { ControlError } from "../security/errors";
import { enqueueJob } from "./jobs";
import { assignAgent, getWorkItem, transitionWorkItem } from "./work-items";

/** A human answers an agent's question; the asking agent resumes. */
export function provideInformation(ctx: AppContext, input: { workItemId: string; actorId: string; answer: string }) {
  return guard(ctx, { actorId: input.actorId, action: "work_item.respond", workItemId: input.workItemId }, () => {
    authorize(ctx, input.actorId, "workitem:respond");
    const item = getWorkItem(ctx, input.workItemId);
    const answer = input.answer.trim();
    if (item.state !== "NEEDS_INFO" || !item.pendingQuestion) {
      throw new ControlError("Work item is not waiting for information", "STATE_MACHINE");
    }
    if (answer.length < 3) throw new ControlError("Answer is empty", "REASON_REQUIRED", "FAILED");
    const question = item.pendingQuestion;
    const ts = nowIso();
    const findingId = nextId(ctx, "F", 5001);
    const evidenceId = nextId(ctx, "EV", 4001);
    ctx.db
      .insert(evidence)
      .values({
        id: evidenceId,
        workItemId: item.id,
        sourceType: "human_input",
        sourceId: findingId,
        label: "Controller input",
        snapshot: { question: question.question, answer, providedBy: input.actorId },
        collectedBy: input.actorId,
        createdAt: ts,
      })
      .run();
    ctx.db
      .insert(findings)
      .values({
        id: findingId,
        workItemId: item.id,
        agentId: input.actorId,
        kind: "human",
        summary: answer,
        assessment: null,
        data: { question: question.question },
        evidenceIds: [evidenceId],
        createdAt: ts,
      })
      .run();
    ctx.db.update(workItems).set({ pendingQuestion: null }).where(eq(workItems.id, item.id)).run();
    appendAudit(ctx, {
      actorId: input.actorId,
      action: "work_item.respond",
      category: "write",
      targetType: "work_item",
      targetId: item.id,
      workItemId: item.id,
      evidenceIds: [evidenceId],
      details: { question: question.question, answer },
    });
    recordActivity(ctx, {
      workItemId: item.id,
      actorId: input.actorId,
      type: "FINDING",
      title: (getActor(ctx, input.actorId)?.name ?? input.actorId) + " provided information",
      summary: answer,
      evidenceIds: [evidenceId],
    });
    transitionWorkItem(ctx, item.id, "INVESTIGATING", input.actorId, "Information provided; resuming " + question.agentId);
    assignAgent(ctx, item.id, question.agentId);
    enqueueJob(ctx, { workItemId: item.id, kind: "AGENT_RUN", agentId: question.agentId, payload: { trigger: "human_info", findingId } });
    return { findingId };
  });
}
