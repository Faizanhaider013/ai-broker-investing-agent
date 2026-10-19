CREATE TABLE `qwksearch_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`connection` text,
	`preferences` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
