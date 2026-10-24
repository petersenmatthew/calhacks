CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`destination` text NOT NULL,
	`subject` text,
	`body` text NOT NULL,
	`html` text,
	`mentions` text NOT NULL,
	`attachments` text NOT NULL,
	`event` text NOT NULL,
	`work_item_id` text,
	`ref` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`provider_message_id` text,
	`created_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE INDEX `outbox_status_idx` ON `outbox` (`status`);--> statement-breakpoint
CREATE INDEX `outbox_channel_idx` ON `outbox` (`channel`,`destination`);--> statement-breakpoint
ALTER TABLE `providers` ADD `billing_email` text;--> statement-breakpoint
ALTER TABLE `vendor_disputes` ADD `letter_subject` text;--> statement-breakpoint
ALTER TABLE `vendor_disputes` ADD `letter_body` text;--> statement-breakpoint
ALTER TABLE `vendor_disputes` ADD `evidence` text;--> statement-breakpoint
ALTER TABLE `vendor_disputes` ADD `sent_to` text;--> statement-breakpoint
ALTER TABLE `vendor_disputes` ADD `email_status` text;