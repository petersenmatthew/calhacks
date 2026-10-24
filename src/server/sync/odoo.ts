import { asc, eq, inArray } from "drizzle-orm";
import { recordActivity } from "../activity";
import { appendAudit } from "../audit";
import { nowIso, type AppContext } from "../context";
import {
  erpLinks,
  ingestionEvents,
  invoiceLines,
  invoices,
  journalEntries,
  journalLines,
  projects,
  providers,
  syncCursors,
} from "../db/schema";
import { ACTOR } from "../security/actors";
import { authorize } from "../security/authorize";
import { ACCOUNTS } from "../workflow/ledger";
import { lagoInvoicePdf, type Fetcher, type LagoConfig } from "./lago";

/*
 * Atlas Research's ERP is Odoo 18 Community (sandboxes/docker-compose.yml).
 *
 * The ledger gateway stays the only place that decides a posting. Once an
 * entry is committed, the scheduler records it in Odoo the way an accountant
 * would: a vendor invoice becomes a vendor bill (with the provider's PDF), a
 * vendor credit becomes a credit note, and an allocation becomes a journal
 * entry tagged with each research team's analytic account. erp_links holds
 * the Odoo record for every entry, so nothing is recorded twice, and a failed
 * write is retried on the next tick.
 */

export interface OdooConfig {
  url: string;
  db: string;
  user: string;
  password: string;
}

export const ODOO_SOURCE = "odoo-erp";
const BATCH = 10;
const MAX_ATTEMPTS = 5;

type M2M = [number, number, Record<string, unknown> | number[]];

export class OdooClient {
  private uid: number | null = null;
  constructor(
    private cfg: OdooConfig,
    private fetcher: Fetcher = fetch,
  ) {}

  private async rpc(service: string, method: string, args: unknown[]) {
    const res = await this.fetcher(this.cfg.url.replace(/\/$/, "") + "/jsonrpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
    });
    if (!res.ok) throw new Error("Odoo HTTP " + res.status);
    const body = (await res.json()) as { result?: unknown; error?: { data?: { message?: string }; message?: string } };
    if (body.error) throw new Error("Odoo: " + (body.error.data?.message ?? body.error.message ?? "error"));
    return body.result;
  }

  async login() {
    if (this.uid) return this.uid;
    const uid = (await this.rpc("common", "login", [this.cfg.db, this.cfg.user, this.cfg.password])) as number | false;
    if (!uid) throw new Error("Odoo login failed for " + this.cfg.user + " on database " + this.cfg.db);
    this.uid = uid;
    return uid;
  }

  async call<T = unknown>(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<T> {
    const uid = await this.login();
    return (await this.rpc("object", "execute_kw", [this.cfg.db, uid, this.cfg.password, model, method, args, kwargs])) as T;
  }

  async findOne(model: string, domain: unknown[]): Promise<number | null> {
    const ids = await this.call<number[]>(model, "search", [domain], { limit: 1 });
    return ids[0] ?? null;
  }

  async ensure(model: string, domain: unknown[], values: Record<string, unknown>): Promise<number> {
    return (await this.findOne(model, domain)) ?? (await this.call<number>(model, "create", [values]));
  }

  /** Turn on the accounting features this integration uses (analytic accounts, full accounting) for its own user. */
  async enableGroups(xmlIds: string[]) {
    const uid = await this.login();
    const groups: number[] = [];
    for (const xmlId of xmlIds) {
      const [module, name] = xmlId.split(".");
      const rows = await this.call<{ res_id: number }[]>("ir.model.data", "search_read", [[["module", "=", module], ["name", "=", name]]], { fields: ["res_id"], limit: 1 });
      if (rows[0]) groups.push(rows[0].res_id);
    }
    if (groups.length) await this.call("res.users", "write", [[uid], { groups_id: groups.map((g) => [4, g]) }]);
  }
}

interface OdooBooks {
  accounts: Record<string, number>;
  analytic: Record<string, number>;
  partners: Record<string, number>;
  purchaseJournal: number;
  generalJournal: number;
}

const books = new Map<string, OdooBooks>();

/** Chart of accounts, research-team analytic accounts, and vendors, created once in Odoo. */
export async function ensureOdooBooks(ctx: AppContext, client: OdooClient, key: string): Promise<OdooBooks> {
  const cached = books.get(key);
  if (cached) return cached;
  const companyId = (await client.findOne("res.company", [])) ?? 1;
  await client.call("res.company", "write", [[companyId], { name: "Atlas Research" }]);
  await client.enableGroups(["analytic.group_analytic_accounting", "account.group_account_user"]);

  const payable = await client.findOne("account.account", [["account_type", "=", "liability_payable"]]);
  if (!payable) throw new Error("Odoo has no payable account; is Invoicing installed?");
  const accounts: Record<string, number> = {
    [ACCOUNTS.AP]: payable,
    [ACCOUNTS.COMPUTE_EXPENSE]: await client.ensure("account.account", [["code", "=", ACCOUNTS.COMPUTE_EXPENSE]], {
      code: ACCOUNTS.COMPUTE_EXPENSE,
      name: "GPU Compute Expense (by project)",
      account_type: "expense",
    }),
    [ACCOUNTS.CLEARING]: await client.ensure("account.account", [["code", "=", ACCOUNTS.CLEARING]], {
      code: ACCOUNTS.CLEARING,
      name: "Compute Clearing (unallocated)",
      account_type: "expense",
    }),
  };

  const plan = await client.ensure("account.analytic.plan", [["name", "=", "Research teams"]], { name: "Research teams" });
  const analytic: Record<string, number> = {};
  for (const p of ctx.db.select().from(projects).all()) {
    analytic[p.id] = await client.ensure("account.analytic.account", [["code", "=", p.id]], { name: p.name, code: p.id, plan_id: plan });
  }

  const partners: Record<string, number> = {};
  for (const v of ctx.db.select().from(providers).all()) {
    partners[v.id] = await client.ensure("res.partner", [["ref", "=", v.id]], {
      name: v.name,
      ref: v.id,
      email: v.billingEmail,
      is_company: true,
      supplier_rank: 1,
    });
  }

  const purchaseJournal = await client.findOne("account.journal", [["type", "=", "purchase"]]);
  const generalJournal = await client.findOne("account.journal", [["type", "=", "general"]]);
  if (!purchaseJournal || !generalJournal) throw new Error("Odoo is missing a purchase or general journal");
  const out = { accounts, analytic, partners, purchaseJournal, generalJournal };
  books.set(key, out);
  return out;
}

type Entry = typeof journalEntries.$inferSelect;
type Line = typeof journalLines.$inferSelect;

export type OdooDocKind = "vendor_bill" | "credit_note" | "journal_entry";

/** How an Atlas journal entry is recorded in Odoo. */
export function odooKind(entry: Entry, lines: Line[]): OdooDocKind {
  const apCredit = lines.some((l) => l.accountCode === ACCOUNTS.AP && l.creditCents > 0);
  const apDebit = lines.some((l) => l.accountCode === ACCOUNTS.AP && l.debitCents > 0);
  if (entry.source === "erp_ap" && apCredit) return "vendor_bill";
  // A full vendor credit is a credit note. A partial credit also charges a team, so it stays a journal entry.
  if (apDebit && lines.every((l) => l.accountCode === ACCOUNTS.AP || l.debitCents === 0)) return "credit_note";
  return "journal_entry";
}

const day = (iso: string) => iso.slice(0, 10);
const dollars = (cents: number) => Math.round(cents) / 100;

function analyticFor(b: OdooBooks, projectId: string | null) {
  return projectId && b.analytic[projectId] ? { [String(b.analytic[projectId])]: 100 } : false;
}

/** Build the Odoo account.move values for one entry. Pure, so it can be tested without Odoo. */
export function moveValues(
  entry: Entry,
  lines: Line[],
  b: OdooBooks,
  context: { providerId: string | null; invoiceNumber: string | null; externalLineId: string | null; issuedAt: string | null; quantity: number | null; unitPriceCents: number | null },
): Record<string, unknown> {
  const kind = odooKind(entry, lines);
  const partner = context.providerId ? b.partners[context.providerId] : undefined;
  const narration = "Recorded from ExperimentLedger " + entry.id + ". Authorization: " + entry.authorization;
  if (kind === "journal_entry") {
    return {
      move_type: "entry",
      journal_id: b.generalJournal,
      date: day(entry.postedAt),
      ref: entry.id + " " + entry.memo,
      narration,
      line_ids: lines.map((l): M2M => [
        0,
        0,
        {
          name: l.memo,
          account_id: b.accounts[l.accountCode],
          debit: dollars(l.debitCents),
          credit: dollars(l.creditCents),
          partner_id: l.accountCode === ACCOUNTS.AP ? partner ?? false : false,
          analytic_distribution: analyticFor(b, l.projectId),
        },
      ]),
    };
  }
  if (!partner) throw new Error("No Odoo vendor for " + entry.id);
  const others = lines.filter((l) => l.accountCode !== ACCOUNTS.AP);
  const exact =
    kind === "vendor_bill" && others.length === 1 && context.quantity && context.unitPriceCents !== null &&
    Math.round(context.quantity * context.unitPriceCents) === others[0].debitCents;
  const date = day(kind === "vendor_bill" && context.issuedAt ? context.issuedAt : entry.postedAt);
  return {
    move_type: kind === "vendor_bill" ? "in_invoice" : "in_refund",
    journal_id: b.purchaseJournal,
    partner_id: partner,
    invoice_date: date,
    date,
    ref: kind === "vendor_bill" ? context.externalLineId ?? context.invoiceNumber ?? entry.id : entry.memo,
    narration,
    invoice_line_ids: others.map((l): M2M => [
      0,
      0,
      {
        name: l.memo,
        account_id: b.accounts[l.accountCode],
        quantity: exact ? context.quantity : 1,
        price_unit: exact ? dollars(context.unitPriceCents!) : dollars(l.debitCents + l.creditCents),
        tax_ids: [[6, 0, []]],
        analytic_distribution: analyticFor(b, l.projectId),
      },
    ]),
  };
}

type DocState = "attached" | "pending" | null;

/** Attach the provider's own invoice PDF to the Odoo vendor bill. "pending" while the provider is still rendering it. */
async function attachProviderPdf(ctx: AppContext, client: OdooClient, moveId: number, invoiceLineId: string, lago: LagoConfig | null, fetcher: Fetcher): Promise<DocState> {
  const event = ctx.db.select().from(ingestionEvents).where(eq(ingestionEvents.invoiceLineId, invoiceLineId)).get();
  const payload = event?.payload as { document?: { invoiceId?: string }; invoice?: { invoiceNumber?: string } } | undefined;
  if (!payload?.document?.invoiceId || !lago) return null;
  const pdf = await lagoInvoicePdf(lago, payload.document.invoiceId, fetcher);
  if (!pdf) return "pending";
  const datas = pdf.toString("base64");
  const invoiceNumber = payload.invoice?.invoiceNumber ?? "invoice";
  await client.call("ir.attachment", "create", [
    { name: invoiceNumber + ".pdf", type: "binary", datas, res_model: "account.move", res_id: moveId, mimetype: "application/pdf" },
  ]);
  return "attached";
}

async function recordEntry(ctx: AppContext, client: OdooClient, b: OdooBooks, entry: Entry, lago: LagoConfig | null, fetcher: Fetcher) {
  const lines = ctx.db.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).orderBy(asc(journalLines.lineNo)).all();
  const line = entry.invoiceLineId ? ctx.db.select().from(invoiceLines).where(eq(invoiceLines.id, entry.invoiceLineId)).get() : undefined;
  const invoice = line ? ctx.db.select().from(invoices).where(eq(invoices.id, line.invoiceId)).get() : undefined;
  const values = moveValues(entry, lines, b, {
    providerId: invoice?.providerId ?? null,
    invoiceNumber: invoice?.invoiceNumber ?? null,
    externalLineId: line?.externalLineId ?? null,
    issuedAt: invoice?.issuedAt ?? null,
    quantity: line?.quantity ?? null,
    unitPriceCents: line?.unitPriceCents ?? null,
  });
  let moveId: number;
  try {
    moveId = await client.call<number>("account.move", "create", [values]);
    await client.call("account.move", "action_post", [[moveId]]);
  } catch (error) {
    // The Odoo database outlives a demo reset, so a vendor reference can repeat.
    if (!/duplicate|duplicated/i.test(String(error)) || values.move_type === "entry") throw error;
    moveId = await client.call<number>("account.move", "create", [{ ...values, ref: values.ref + " (" + entry.id + ", " + entry.postedAt.slice(0, 19) + ")" }]);
    await client.call("account.move", "action_post", [[moveId]]);
  }
  const [move] = await client.call<{ name: string }[]>("account.move", "read", [[moveId]], { fields: ["name"] });
  let document: DocState = null;
  if (values.move_type === "in_invoice" && line) {
    try {
      document = await attachProviderPdf(ctx, client, moveId, line.id, lago, fetcher);
    } catch {
      document = "pending";
    }
  }
  const kind = odooKind(entry, lines);
  const appliedTo = kind === "credit_note" && line ? await applyCreditToBill(ctx, client, moveId, line.id) : null;
  return { moveId, name: move?.name ?? String(moveId), kind, document, appliedTo };
}

/** Apply a vendor credit note to the bill for the same invoice line, as AP would. Returns the bill's name. */
async function applyCreditToBill(ctx: AppContext, client: OdooClient, creditMoveId: number, invoiceLineId: string) {
  const bill = ctx.sqlite
    .prepare("SELECT l.odoo_id AS odooId, l.odoo_name AS name FROM erp_links l JOIN journal_entries je ON je.id = l.entry_id WHERE je.invoice_line_id = ? AND l.kind = 'vendor_bill' AND l.status = 'synced'")
    .get(invoiceLineId) as { odooId: number; name: string } | undefined;
  if (!bill) return null;
  const payable = await client.call<number[]>("account.move.line", "search", [
    [["move_id", "in", [bill.odooId, creditMoveId]], ["account_id.account_type", "=", "liability_payable"], ["reconciled", "=", false]],
  ]);
  if (payable.length < 2) return null;
  try {
    await client.call("account.move.line", "reconcile", [payable]);
  } catch {
    // reconcile() can return values JSON-RPC cannot serialize; the residual below is the real answer.
  }
  const [credit] = await client.call<{ amount_residual: number }[]>("account.move", "read", [[creditMoveId]], { fields: ["amount_residual"] });
  return credit && credit.amount_residual === 0 ? bill.name : null;
}

/** Bills whose provider PDF was not ready when they were recorded. */
async function attachPendingPdfs(ctx: AppContext, client: OdooClient, lago: LagoConfig | null, fetcher: Fetcher) {
  const waiting = ctx.db.select().from(erpLinks).where(eq(erpLinks.document, "pending")).limit(5).all();
  for (const link of waiting) {
    const entry = ctx.db.select().from(journalEntries).where(eq(journalEntries.id, link.entryId)).get();
    if (!entry?.invoiceLineId || !link.odooId) continue;
    try {
      const state = await attachProviderPdf(ctx, client, link.odooId, entry.invoiceLineId, lago, fetcher);
      if (state !== "pending") ctx.db.update(erpLinks).set({ document: state }).where(eq(erpLinks.entryId, link.entryId)).run();
    } catch {
      /* try again next tick */
    }
  }
}

function pendingEntries(ctx: AppContext): Entry[] {
  const rows = ctx.sqlite
    .prepare(
      "SELECT je.id FROM journal_entries je LEFT JOIN erp_links l ON l.entry_id = je.id WHERE l.entry_id IS NULL OR (l.status = 'failed' AND l.attempts < ?) ORDER BY je.rowid LIMIT ?",
    )
    .all(MAX_ATTEMPTS, BATCH) as { id: string }[];
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const entries = ctx.db.select().from(journalEntries).where(inArray(journalEntries.id, ids)).all();
  return ids.map((id) => entries.find((e) => e.id === id)!).filter(Boolean);
}

function writeCursor(ctx: AppContext, cursor: string | null, count: number, error: string | null) {
  const prev = ctx.db.select().from(syncCursors).where(eq(syncCursors.source, ODOO_SOURCE)).get();
  const values = { cursor: cursor ?? prev?.cursor ?? null, syncedAt: nowIso(), lastCount: count, totalCount: (prev?.totalCount ?? 0) + count, lastError: error };
  ctx.db.insert(syncCursors).values({ source: ODOO_SOURCE, ...values }).onConflictDoUpdate({ target: syncCursors.source, set: values }).run();
}

/** Record newly committed journal entries in Odoo. Runs on every scheduler tick. */
export async function syncOdoo(ctx: AppContext, cfg: OdooConfig, lago: LagoConfig | null = null, fetcher: Fetcher = fetch) {
  authorize(ctx, ACTOR.erp, "erp:record");
  const pending = pendingEntries(ctx);
  const docsWaiting = ctx.db.select().from(erpLinks).where(eq(erpLinks.document, "pending")).limit(1).get();
  if (!pending.length && !docsWaiting) return { recorded: 0, failed: 0 };
  const client = new OdooClient(cfg, fetcher);
  let b: OdooBooks;
  try {
    b = await ensureOdooBooks(ctx, client, cfg.url + "/" + cfg.db);
  } catch (error) {
    writeCursor(ctx, null, 0, error instanceof Error ? error.message : String(error));
    return { recorded: 0, failed: pending.length };
  }
  if (docsWaiting) await attachPendingPdfs(ctx, client, lago, fetcher);
  let recorded = 0;
  let failed = 0;
  let lastError: string | null = null;
  const names: string[] = [];
  for (const entry of pending) {
    const prev = ctx.db.select().from(erpLinks).where(eq(erpLinks.entryId, entry.id)).get();
    try {
      const out = await recordEntry(ctx, client, b, entry, lago, fetcher);
      const values = { status: "synced", odooModel: "account.move", odooId: out.moveId, odooName: out.name, kind: out.kind, document: out.document, attempts: (prev?.attempts ?? 0) + 1, lastError: null, syncedAt: nowIso() };
      ctx.db.insert(erpLinks).values({ entryId: entry.id, ...values }).onConflictDoUpdate({ target: erpLinks.entryId, set: values }).run();
      appendAudit(ctx, {
        actorId: ACTOR.erp,
        action: "erp.record",
        category: "posting",
        targetType: "journal_entry",
        targetId: entry.id,
        workItemId: entry.workItemId,
        details: { system: "Odoo", odooModel: "account.move", odooId: out.moveId, odooName: out.name, kind: out.kind, providerPdf: out.document, appliedTo: out.appliedTo },
      });
      names.push(out.appliedTo ? out.name + " (applied to " + out.appliedTo + ")" : out.name);
      recorded += 1;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const values = { status: "failed", odooModel: "account.move", odooId: null, odooName: null, kind: null, document: null, attempts: (prev?.attempts ?? 0) + 1, lastError, syncedAt: nowIso() };
      ctx.db.insert(erpLinks).values({ entryId: entry.id, ...values }).onConflictDoUpdate({ target: erpLinks.entryId, set: values }).run();
      appendAudit(ctx, {
        actorId: ACTOR.erp,
        action: "erp.record",
        outcome: "FAILED",
        category: "posting",
        targetType: "journal_entry",
        targetId: entry.id,
        workItemId: entry.workItemId,
        details: { system: "Odoo", error: lastError, attempt: values.attempts },
      });
      failed += 1;
    }
  }
  writeCursor(ctx, recorded ? pending[pending.length - 1].id : null, recorded, lastError);
  if (recorded || failed) {
    recordActivity(ctx, {
      actorId: ACTOR.erp,
      type: failed ? "ERROR" : "INGESTION",
      status: failed ? "error" : "ok",
      title: recorded ? "Recorded " + recorded + " entr" + (recorded === 1 ? "y" : "ies") + " in Odoo" : "Could not record entries in Odoo",
      summary: (names.length ? names.join(", ") + ". " : "") + (failed ? failed + " failed and will be retried: " + lastError : ""),
    });
  }
  return { recorded, failed };
}

/** The Odoo record for each journal entry, for the audit view. */
export function odooLinks(ctx: AppContext) {
  return ctx.db.select().from(erpLinks).all();
}
