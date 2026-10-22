CREATE TABLE `listing_controls` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`item_id` text NOT NULL,
	`published` integer DEFAULT true NOT NULL,
	`label` text,
	`note` text,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `listing_controls_kind_published_idx` ON `listing_controls` (`kind`,`published`);
