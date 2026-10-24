import type { AppContext } from "../context";
import { tx } from "../context";
import { recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { getActor } from "./actors";
import { ControlError, isControlError } from "./errors";
import { roleHas, type Permission } from "./permissions";

/** Throws a ControlError if the actor's role lacks the permission. */
export function authorize(ctx: AppContext, actorId: string, permission: Permission) {
  const actor = getActor(ctx, actorId);
  if (actor && roleHas(actor.role, permission)) return actor;
  const who = actor ? actor.name + " (" + actor.role + ")" : "Unknown actor " + actorId;
  throw new ControlError(who + " is not permitted to perform " + permission, "RBAC");
}

export interface GuardMeta {
  actorId: string;
  action: string;
  workItemId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  runId?: string | null;
  mode?: string | null;
}

/** Write a denial to the audit log and the live activity stream. */
export function recordDenial(ctx: AppContext, meta: GuardMeta, error: ControlError) {
  appendAudit(ctx, {
    actorId: meta.actorId,
    action: meta.action,
    outcome: error.outcome,
    category: "security",
    targetType: meta.targetType ?? null,
    targetId: meta.targetId ?? null,
    workItemId: meta.workItemId ?? null,
    rule: error.rule,
    details: { reason: error.message },
  });
  if (meta.workItemId) {
    const actor = getActor(ctx, meta.actorId);
    recordActivity(ctx, {
      workItemId: meta.workItemId,
      runId: meta.runId ?? null,
      mode: meta.mode ?? null,
      actorId: meta.actorId,
      type: error.outcome === "DENIED" ? "DENIED" : "ERROR",
      status: error.outcome === "DENIED" ? "denied" : "error",
      title: (actor?.name ?? meta.actorId) + (error.outcome === "DENIED" ? " was denied: " : " failed: ") + meta.action,
      summary: error.message + " [" + error.rule + "]",
    });
  }
  error.recorded = true;
}

/**
 * Run fn in a transaction. If it violates a control, the transaction rolls
 * back and the violation is recorded afterwards (outside the rolled-back
 * transaction) so the audit trail keeps every denied action.
 */
export function guard<T>(ctx: AppContext, meta: GuardMeta, fn: () => T): T {
  try {
    return tx(ctx, fn);
  } catch (error) {
    if (isControlError(error) && !error.recorded && !ctx.sqlite.inTransaction) {
      recordDenial(ctx, meta, error);
    }
    throw error;
  }
}
