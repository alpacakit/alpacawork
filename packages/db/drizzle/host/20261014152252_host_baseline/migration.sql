CREATE TABLE `episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`start_at` integer NOT NULL,
	`end_at` integer,
	`last_at` integer NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `minutes` (
	`at` integer PRIMARY KEY,
	`cpu_average` real,
	`cpu_max` real,
	`memory_free_average` real NOT NULL,
	`memory_free_min` real NOT NULL
);
