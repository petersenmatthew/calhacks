import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema>;

/** Tables whose rows may never be changed or removed once written. */
const APPEND_ONLY_TABLES = ["audit_events", "journal_entries", "journal_lines"] as const;

function migrationsFolder() {
  return path.join(process.cwd(), "drizzle");
}

export function openDatabase(file: string) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsFolder() });
  installGuards(sqlite);
  return { sqlite, db };
}

/**
 * Database-level controls. These hold even if application code is bypassed:
 * audit events and journal postings are append-only, proposal content is
 * immutable after creation, and approval decisions are final.
 */
export function installGuards(sqlite: Database.Database) {
  for (const table of APPEND_ONLY_TABLES) {
    sqlite.exec(
      "CREATE TRIGGER IF NOT EXISTS " + table + "_no_update BEFORE UPDATE ON " + table +
        " BEGIN SELECT RAISE(ABORT, '" + table + " is append-only'); END;",
    );
    sqlite.exec(
      "CREATE TRIGGER IF NOT EXISTS " + table + "_no_delete BEFORE DELETE ON " + table +
        " BEGIN SELECT RAISE(ABORT, '" + table + " is append-only'); END;",
    );
  }
  sqlite.exec(
    "CREATE TRIGGER IF NOT EXISTS proposals_content_immutable BEFORE UPDATE OF payload, method, created_by, work_item_id, version ON proposals" +
      " BEGIN SELECT RAISE(ABORT, 'proposal content is immutable'); END;",
  );
  sqlite.exec(
    "CREATE TRIGGER IF NOT EXISTS approvals_decisions_final BEFORE UPDATE ON approval_requests WHEN OLD.status <> 'PENDING'" +
      " BEGIN SELECT RAISE(ABORT, 'approval decisions are final'); END;",
  );
}

export function dropGuards(sqlite: Database.Database) {
  for (const table of APPEND_ONLY_TABLES) {
    sqlite.exec("DROP TRIGGER IF EXISTS " + table + "_no_update;");
    sqlite.exec("DROP TRIGGER IF EXISTS " + table + "_no_delete;");
  }
  sqlite.exec("DROP TRIGGER IF EXISTS proposals_content_immutable;");
  sqlite.exec("DROP TRIGGER IF EXISTS approvals_decisions_final;");
}

/** Every application table, used by the demo reset. */
export const ALL_TABLES = [
  "counters", "settings", "projects", "providers", "contracts", "experiments", "reservations",
  "gpu_instances", "lifecycle_events", "compute_jobs", "provider_usage", "invoices", "invoice_lines",
  "precedents", "ledger_accounts", "journal_entries", "journal_lines", "actors", "ingestion_events",
  "reconciliations", "work_items", "work_item_transitions", "findings", "evidence", "activity_events",
  "agent_runs", "jobs", "proposals", "approval_requests", "policies", "vendor_disputes", "audit_events",
  "feed_events", "sync_cursors", "follow_ups", "erp_ap_history", "outbox", "vendor_messages", "erp_links",
] as const;
