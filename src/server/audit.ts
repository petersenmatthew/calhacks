import crypto from "node:crypto";
import { asc } from "drizzle-orm";
import { nowIso, type AppContext } from "./context";
import { auditEvents } from "./db/schema";
import { getActor } from "./security/actors";

export type AuditCategory = "read" | "write" | "decision" | "posting" | "security" | "system";

export interface AuditInput {
  actorId: string;
  action: string;
  outcome?: "ALLOWED" | "DENIED" | "FAILED";
  category: AuditCategory;
  targetType?: string | null;
  targetId?: string | null;
  workItemId?: string | null;
  policyId?: string | null;
  approvalId?: string | null;
  rule?: string | null;
  evidenceIds?: string[];
  details?: Record<string, unknown>;
}

/** JSON with sorted keys, so hashes are reproducible from stored rows. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + stableStringify(v)).join(",") + "}";
}

function sha256(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function hashedFields(row: {
  ts: string;
  actorId: string;
  actorKind: string;
  action: string;
  outcome: string;
  category: string;
  targetType: string | null;
  targetId: string | null;
  workItemId: string | null;
  policyId: string | null;
  approvalId: string | null;
  rule: string | null;
  evidenceIds: string[];
  details: Record<string, unknown>;
}) {
  return stableStringify(row);
}

/** Append an audit event. Each event is chained to the previous one by hash. */
export function appendAudit(ctx: AppContext, input: AuditInput) {
  const prev = ctx.sqlite.prepare("SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1").get() as
    | { hash: string }
    | undefined;
  const prevHash = prev?.hash ?? "GENESIS";
  const record = {
    ts: nowIso(),
    actorId: input.actorId,
    actorKind: getActor(ctx, input.actorId)?.kind ?? "unknown",
    action: input.action,
    outcome: input.outcome ?? "ALLOWED",
    category: input.category,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    workItemId: input.workItemId ?? null,
    policyId: input.policyId ?? null,
    approvalId: input.approvalId ?? null,
    rule: input.rule ?? null,
    evidenceIds: input.evidenceIds ?? [],
    details: JSON.parse(JSON.stringify(input.details ?? {})) as Record<string, unknown>,
  };
  const hash = sha256(prevHash + hashedFields(record));
  ctx.db.insert(auditEvents).values({ ...record, prevHash, hash }).run();
}

/** Recompute the hash chain to prove no audit event was altered or removed. */
export function verifyAuditChain(ctx: AppContext) {
  const rows = ctx.db.select().from(auditEvents).orderBy(asc(auditEvents.id)).all();
  let prev = "GENESIS";
  for (const row of rows) {
    const expected = sha256(
      prev +
        hashedFields({
          ts: row.ts,
          actorId: row.actorId,
          actorKind: row.actorKind,
          action: row.action,
          outcome: row.outcome,
          category: row.category,
          targetType: row.targetType,
          targetId: row.targetId,
          workItemId: row.workItemId,
          policyId: row.policyId,
          approvalId: row.approvalId,
          rule: row.rule,
          evidenceIds: row.evidenceIds,
          details: row.details,
        }),
    );
    if (row.prevHash !== prev || row.hash !== expected) {
      return { ok: false, count: rows.length, brokenAtId: row.id };
    }
    prev = row.hash;
  }
  return { ok: true, count: rows.length, brokenAtId: null as number | null };
}
