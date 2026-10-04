ALTER TABLE `pages` ADD `tracking_id` text;--> statement-breakpoint
ALTER TABLE `pages` ADD `duration_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_pages_tracking` ON `pages` (`site_id`,`tracking_id`);--> statement-breakpoint
ALTER TABLE `visits` ADD `duration_ms` integer;--> statement-breakpoint
CREATE INDEX `idx_visits_site_started_visitor` ON `visits` (`site_id`,`started_at`,`visitor_id`);