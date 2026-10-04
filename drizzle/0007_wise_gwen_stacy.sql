CREATE TABLE `source_details_cache` (
	`site_id` text NOT NULL,
	`key` text NOT NULL,
	`details` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `key`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_source_details_cache_expiry` ON `source_details_cache` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_sources_site_campaign` ON `sources` (`site_id`,`utm_source`,`utm_medium`,`utm_campaign`);--> statement-breakpoint
CREATE INDEX `idx_visits_site_source_started` ON `visits` (`site_id`,`source_id`,`started_at`);