CREATE TABLE `payments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text NOT NULL,
	`provider` text NOT NULL,
	`order_id` text NOT NULL,
	`page_id` integer,
	`reference` text,
	`amount` integer NOT NULL,
	`refunded_amount` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`product` text,
	`billing_reason` text,
	`paid_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_payments_order` ON `payments` (`provider`,`order_id`);--> statement-breakpoint
CREATE INDEX `idx_payments_site_paid` ON `payments` (`site_id`,`paid_at`);--> statement-breakpoint
CREATE INDEX `idx_payments_page` ON `payments` (`page_id`);--> statement-breakpoint
CREATE INDEX `idx_events_visit` ON `events` (`visit_id`);