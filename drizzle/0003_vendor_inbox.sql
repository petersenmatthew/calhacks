CREATE TABLE `vendor_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`dispute_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`direction` text NOT NULL,
	`from_addr` text,
	`to_addr` text,
	`subject` text,
	`body` text NOT NULL,
	`message_id` text,
	`in_reply_to` text,
	`status` text NOT NULL,
	`kind` text,
	`handled_by` text,
	`handled_at` text,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_messages_message_id_idx` ON `vendor_messages` (`message_id`);--> statement-breakpoint
CREATE INDEX `vendor_messages_dispute_idx` ON `vendor_messages` (`dispute_id`);--> statement-breakpoint
ALTER TABLE `outbox` ADD `headers` text;--> statement-breakpoint
ALTER TABLE `vendor_disputes` ADD `credited_cents` integer;