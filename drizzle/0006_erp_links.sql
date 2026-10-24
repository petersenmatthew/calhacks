CREATE TABLE `erp_links` (
	`entry_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`odoo_model` text,
	`odoo_id` integer,
	`odoo_name` text,
	`kind` text,
	`document` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`synced_at` text NOT NULL
);
