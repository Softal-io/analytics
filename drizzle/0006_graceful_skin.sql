CREATE TABLE `tracking_contexts` (
	`site_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`visitor_id` text NOT NULL,
	`last_seen` integer NOT NULL,
	PRIMARY KEY(`site_id`, `key_hash`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`visitor_id`) REFERENCES `visitors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tracking_contexts_seen` ON `tracking_contexts` (`last_seen`);--> statement-breakpoint
ALTER TABLE `visits` ADD `referrer_url` text;--> statement-breakpoint
ALTER TABLE `visits` ADD `landing_url` text;