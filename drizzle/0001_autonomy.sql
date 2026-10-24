CREATE TABLE `erp_ap_history` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`invoice_number` text NOT NULL,
	`line_ref` text NOT NULL,
	`period` text NOT NULL,
	`description` text NOT NULL,
	`invoiced_cents` integer NOT NULL,
	`expected_cents` integer NOT NULL,
	`variance_cents` integer NOT NULL,
	`resolution` text NOT NULL,
	`resolved_by` text NOT NULL,
	`note` text NOT NULL,
	`resolved_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `feed_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`external_event_id` text NOT NULL,
	`publish_at` text NOT NULL,
	`label` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feed_events_external_idx` ON `feed_events` (`external_event_id`);--> statement-breakpoint
CREATE INDEX `feed_events_source_idx` ON `feed_events` (`source`,`seq`);--> statement-breakpoint
CREATE TABLE `follow_ups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`work_item_id` text,
	`subject_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`business_at` text NOT NULL,
	`created_at` text NOT NULL,
	`details` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `follow_ups_key_idx` ON `follow_ups` (`key`);--> statement-breakpoint
CREATE TABLE `sync_cursors` (
	`source` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`synced_at` text NOT NULL,
	`last_count` integer DEFAULT 0 NOT NULL,
	`total_count` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
