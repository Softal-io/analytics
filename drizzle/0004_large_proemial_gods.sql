CREATE TABLE `daily_rollup_status` (
	`site_id` text NOT NULL,
	`date` text NOT NULL,
	`start_sec` integer NOT NULL,
	`end_sec` integer NOT NULL,
	PRIMARY KEY(`site_id`, `date`)
);
--> statement-breakpoint
ALTER TABLE `events` ADD `tracking_id` text;--> statement-breakpoint
CREATE INDEX `idx_events_site_ts` ON `events` (`site_id`,`timestamp`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_events_tracking` ON `events` (`site_id`,`tracking_id`);--> statement-breakpoint
ALTER TABLE `outbound_links` ADD `tracking_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_outbound_links_tracking` ON `outbound_links` (`site_id`,`tracking_id`);--> statement-breakpoint
ALTER TABLE `pages` ADD `report_key_hash` text;--> statement-breakpoint
ALTER TABLE `pages` ADD `timestamp_ms` integer;