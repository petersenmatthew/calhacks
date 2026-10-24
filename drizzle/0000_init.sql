CREATE TABLE `activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`work_item_id` text,
	`run_id` text,
	`actor_id` text NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`status` text NOT NULL,
	`tool_name` text,
	`args` text,
	`result` text,
	`evidence_ids` text NOT NULL,
	`changes` text NOT NULL,
	`mode` text,
	`duration_ms` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_work_item_idx` ON `activity_events` (`work_item_id`);--> statement-breakpoint
CREATE TABLE `actors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`role` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`mode` text NOT NULL,
	`model` text,
	`task` text NOT NULL,
	`status` text NOT NULL,
	`terminal_action` text,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`error` text,
	`usage` text,
	`started_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`required_role` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`decided_by` text,
	`decision_reason` text,
	`directive` text,
	`created_at` text NOT NULL,
	`decided_at` text
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_kind` text NOT NULL,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`category` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`work_item_id` text,
	`policy_id` text,
	`approval_id` text,
	`rule` text,
	`evidence_ids` text NOT NULL,
	`details` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_work_item_idx` ON `audit_events` (`work_item_id`);--> statement-breakpoint
CREATE TABLE `compute_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`instance_id` text,
	`reservation_id` text,
	`submitted_by` text NOT NULL,
	`gpus` integer NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text NOT NULL,
	`status` text NOT NULL,
	`logs` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_instance_idx` ON `compute_jobs` (`instance_id`);--> statement-breakpoint
CREATE INDEX `jobs_reservation_idx` ON `compute_jobs` (`reservation_id`);--> statement-breakpoint
CREATE TABLE `contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`name` text NOT NULL,
	`effective_from` text NOT NULL,
	`rate_card` text NOT NULL,
	`billing_increment_hours` real NOT NULL,
	`minimum_hours` real NOT NULL,
	`idle_billable` integer NOT NULL,
	`reservations_billed_in_full` integer NOT NULL,
	`clauses` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `counters` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`label` text NOT NULL,
	`snapshot` text NOT NULL,
	`collected_by` text NOT NULL,
	`run_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_source_idx` ON `evidence` (`work_item_id`,`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`owner` text NOT NULL,
	`description` text NOT NULL,
	`tracker` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`run_id` text,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`assessment` text,
	`data` text NOT NULL,
	`evidence_ids` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gpu_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`instance_type` text NOT NULL,
	`gpu_count` integer NOT NULL,
	`region` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ingestion_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`external_event_id` text NOT NULL,
	`source` text NOT NULL,
	`received_at` text NOT NULL,
	`payload` text NOT NULL,
	`invoice_line_id` text,
	`work_item_id` text,
	`outcome` text NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingestion_external_idx` ON `ingestion_events` (`external_event_id`);--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`external_line_id` text NOT NULL,
	`line_type` text NOT NULL,
	`instance_id` text,
	`reservation_id` text,
	`description` text NOT NULL,
	`quantity` real NOT NULL,
	`unit` text NOT NULL,
	`unit_price_cents` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`period` text NOT NULL,
	`service_start` text NOT NULL,
	`service_end` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_lines_external_idx` ON `invoice_lines` (`external_line_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`invoice_number` text NOT NULL,
	`period` text NOT NULL,
	`issued_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`work_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`agent_id` text,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`period` text NOT NULL,
	`posted_at` text NOT NULL,
	`memo` text NOT NULL,
	`source` text NOT NULL,
	`work_item_id` text,
	`invoice_line_id` text,
	`proposal_id` text,
	`approval_id` text,
	`policy_id` text,
	`authorization` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`posted_by` text NOT NULL,
	`total_cents` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_idempotency_idx` ON `journal_entries` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `journal_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entry_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`account_code` text NOT NULL,
	`project_id` text,
	`debit_cents` integer NOT NULL,
	`credit_cents` integer NOT NULL,
	`memo` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `journal_lines_entry_idx` ON `journal_lines` (`entry_id`);--> statement-breakpoint
CREATE TABLE `ledger_accounts` (
	`code` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lifecycle_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` text NOT NULL,
	`event_type` text NOT NULL,
	`occurred_at` text NOT NULL,
	`source` text NOT NULL,
	`reference` text
);
--> statement-breakpoint
CREATE INDEX `lifecycle_instance_idx` ON `lifecycle_events` (`instance_id`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`policy_key` text NOT NULL,
	`version` integer NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`statement` text NOT NULL,
	`rule` text NOT NULL,
	`rationale` text NOT NULL,
	`evidence_ids` text NOT NULL,
	`precedent_ids` text NOT NULL,
	`learned_from_work_item_id` text,
	`proposed_by` text NOT NULL,
	`approved_by` text,
	`approval_id` text,
	`supersedes_id` text,
	`created_at` text NOT NULL,
	`approved_at` text
);
--> statement-breakpoint
CREATE TABLE `precedents` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`decided_at` text NOT NULL,
	`decided_by` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`tags` text NOT NULL,
	`details` text NOT NULL,
	`source` text NOT NULL,
	`work_item_id` text
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`lead` text NOT NULL,
	`cost_center` text NOT NULL,
	`monthly_budget_cents` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`rationale` text NOT NULL,
	`method` text NOT NULL,
	`policy_id` text,
	`payload` text NOT NULL,
	`evidence_ids` text NOT NULL,
	`authorization` text,
	`created_by` text NOT NULL,
	`supersedes_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` text NOT NULL,
	`instance_id` text NOT NULL,
	`usage_start` text NOT NULL,
	`usage_end` text NOT NULL,
	`hours` real NOT NULL,
	`source_ref` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`short_name` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reconciliations` (
	`invoice_line_id` text PRIMARY KEY NOT NULL,
	`period` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text NOT NULL,
	`expected_cents` integer NOT NULL,
	`invoiced_cents` integer NOT NULL,
	`variance_cents` integer NOT NULL,
	`checks` text NOT NULL,
	`work_item_id` text,
	`resolved_at` text
);
--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`owner_project_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`gpu_type` text NOT NULL,
	`gpu_count` integer NOT NULL,
	`hours` real NOT NULL,
	`rate_cents_per_gpu_hour` integer NOT NULL,
	`committed_cents` integer NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`period` text NOT NULL,
	`owner_accountable_for_idle` integer NOT NULL,
	`internal_terms` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vendor_disputes` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`invoice_line_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`approval_id` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`vendor_reference` text,
	`submitted_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE TABLE `work_item_transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`work_item_id` text NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`actor_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`period` text NOT NULL,
	`provider_id` text NOT NULL,
	`invoice_line_id` text NOT NULL,
	`instance_id` text,
	`reservation_id` text,
	`owner_project_id` text,
	`amount_cents` integer NOT NULL,
	`expected_cents` integer NOT NULL,
	`invoiced_cents` integer NOT NULL,
	`discrepancy_cents` integer NOT NULL,
	`checks` text NOT NULL,
	`state` text NOT NULL,
	`priority` integer NOT NULL,
	`assigned_agent_id` text,
	`latest_action` text NOT NULL,
	`outcome` text,
	`pending_question` text,
	`agent_run_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE INDEX `work_items_state_idx` ON `work_items` (`state`);