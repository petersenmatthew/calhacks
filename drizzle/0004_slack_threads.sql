ALTER TABLE `outbox` ADD `provider_channel` text;--> statement-breakpoint
ALTER TABLE `outbox` ADD `thread_of` integer;--> statement-breakpoint
ALTER TABLE `outbox` ADD `broadcast` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `outbox_ref_idx` ON `outbox` (`event`,`ref`);