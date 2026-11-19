/** The host status record: tight episodes (kept 90 days) and one row a minute (kept 7 days). Task facts never belong here. */
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const episodes = sqliteTable('episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  startAt: integer('start_at').notNull(),
  /** Null while the machine is still tight. */
  endAt: integer('end_at'),
  /** The last sample folded into this episode; an episode left open by a stopped server ends here. */
  lastAt: integer('last_at').notNull(),
  /** Which measures were tight, their peaks, and the Runs seen (JSON owned by the host monitor). */
  detail: text('detail').notNull(),
});

export const minutes = sqliteTable('minutes', {
  at: integer('at').primaryKey(),
  cpuAverage: real('cpu_average'),
  cpuMax: real('cpu_max'),
  memoryFreeAverage: real('memory_free_average').notNull(),
  memoryFreeMin: real('memory_free_min').notNull(),
});
