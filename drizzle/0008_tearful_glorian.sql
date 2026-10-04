ALTER TABLE `daily_rollup_status` ADD `failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_rollup_status` ADD `retry_at` integer DEFAULT 0 NOT NULL;