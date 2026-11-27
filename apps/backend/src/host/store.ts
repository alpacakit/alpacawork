/**
 * The host status record in its own sqlite beside the control database: losing it loses only this history.
 * Episodes are kept 90 days and minute values 7 days; the monitor owns what goes in.
 */
import { join } from 'node:path';
import { eq, openDatabase, sql, controlConnectionLease, type Database } from '@alpacawork/db';
import { episodes, minutes } from '@alpacawork/db/host/schema';
import { META_DIRECTORY } from '@alpacawork/raw';
import { hostEpisodeSchema, hostKindSchema, type HostEpisode, type HostEpisodeMinutes, type HostKind } from '@alpacawork/contract';

const HOST_DATABASE = 'host.sqlite';
const DAY = 86_400_000;
export const EPISODE_RETENTION_MS = 90 * DAY;
const MINUTE_RETENTION_MS = 7 * DAY;

export type EpisodeDraft = Omit<HostEpisode, 'id'>;
export type MinuteRow = HostEpisodeMinutes['minutes'][number];

const detailOf = (episode: EpisodeDraft, currentKinds: readonly HostKind[]) =>
  JSON.stringify({ kinds: episode.kinds, currentKinds, peak: episode.peak, runs: episode.runs });
const parseEpisode = (row: typeof episodes.$inferSelect, detail = JSON.parse(row.detail)): HostEpisode => {
  const { kinds, peak, runs } = detail;
  return hostEpisodeSchema.parse({ id: row.id, start: row.startAt, end: row.endAt, kinds, peak, runs });
};

export class HostStore {
  private readonly db: Database;
  private readonly releaseWriter: () => void;

  constructor(root: string) {
    this.releaseWriter = controlConnectionLease(root);
    try { this.db = openDatabase(join(root, META_DIRECTORY, HOST_DATABASE), 'host', { busyTimeoutMs: 3000 }); }
    catch (error) { this.releaseWriter(); throw error; }
  }

  /** The newest episode a stopped server left open, with the last sample folded into it. */
  lastOpen(): { id: number; episode: HostEpisode; lastAt: number; currentKinds: HostKind[] | null } | null {
    const row = this.db.select().from(episodes).where(sql`${episodes.endAt} IS NULL`).orderBy(sql`${episodes.startAt} DESC`).get();
    if (!row) return null;
    const detail = JSON.parse(row.detail);
    const currentKinds = hostKindSchema.array().min(1).safeParse(detail.currentKinds);
    return { id: row.id, lastAt: row.lastAt, episode: parseEpisode(row, detail), currentKinds: currentKinds.data ?? null };
  }

  /** Every other open episode ends at the last sample it saw. */
  closeOpen(except: number | null): void {
    this.db.update(episodes).set({ endAt: sql`${episodes.lastAt}` })
      .where(except === null ? sql`${episodes.endAt} IS NULL` : sql`${episodes.endAt} IS NULL AND ${episodes.id} <> ${except}`).run();
  }

  /** Inserts the episode when it has no id yet; returns its id. */
  saveEpisode(id: number | null, episode: EpisodeDraft, lastAt: number, currentKinds: readonly HostKind[]): number {
    const values = { startAt: episode.start, endAt: episode.end, lastAt, detail: detailOf(episode, currentKinds) };
    if (id !== null) {
      this.db.update(episodes).set(values).where(eq(episodes.id, id)).run();
      return id;
    }
    return Number(this.db.insert(episodes).values(values).run().lastInsertRowid);
  }

  /** Newest first. */
  episodes(since: number): HostEpisode[] {
    return this.db.select().from(episodes).where(sql`${episodes.startAt} >= ${since}`).orderBy(sql`${episodes.startAt} DESC`).all()
      .map(row => parseEpisode(row));
  }

  episode(id: number): HostEpisode | null {
    const row = this.db.select().from(episodes).where(eq(episodes.id, id)).get();
    return row ? parseEpisode(row) : null;
  }

  saveMinute(row: MinuteRow): void {
    this.db.insert(minutes).values(row).onConflictDoUpdate({ target: minutes.at, set: row }).run();
  }

  minutes(from: number, to: number): MinuteRow[] {
    return this.db.select().from(minutes).where(sql`${minutes.at} >= ${from} AND ${minutes.at} <= ${to}`).orderBy(minutes.at).all();
  }

  prune(now: number): void {
    this.db.delete(episodes).where(sql`${episodes.endAt} IS NOT NULL AND ${episodes.endAt} < ${now - EPISODE_RETENTION_MS}`).run();
    this.db.delete(minutes).where(sql`${minutes.at} < ${now - MINUTE_RETENTION_MS}`).run();
  }

  close(): void { try { this.db.$client.close(); } finally { this.releaseWriter(); } }
}
