import { notificationResumeTime, personalSettings, type SettingValues } from '@alpacawork/contract';
import type { PresenceReport } from '@alpacawork/contract/inputs';

export type PresenceStatus = { state: 'present' | 'away' | 'muted'; until: string | null };
type LatestTouch = { screen: string; touchedAt: number; hiddenAt: number | null };
const MINUTE = 60_000;
const LEAVE_GRACE = 30_000;
const MAX_IDLE = Math.max(...personalSettings.flatMap(setting => setting.key === 'push.awayAfter' && setting.kind === 'select'
  ? setting.options.map(option => Number(option.value)) : [])) * MINUTE;

/** The sole presence decision; delivery continues to consume its result. */
export function presenceStatus(latest: LatestTouch | null, settings: SettingValues, elapsed: number, now: number): PresenceStatus {
  const until = notificationResumeTime(now, settings);
  if (until !== null) return { state: 'muted', until: new Date(until).toISOString() };
  const present = latest !== null && elapsed - latest.touchedAt < Number(settings['push.awayAfter']) * MINUTE &&
    (latest.hiddenAt === null || elapsed - latest.hiddenAt < LEAVE_GRACE);
  return { state: present ? 'present' : 'away', until: null };
}

/** Latest touch and per-page report watermarks are ephemeral; a restart begins away. */
export class Presence {
  private latest: LatestTouch | null = null;
  private readonly screens = new Map<string, { seq: number; touchSeq: number; touchedAt: number }>();
  private oldestTouch = -Infinity;
  private manualAwayUntil = -Infinity;
  constructor(private readonly elapsed = () => performance.now(), private readonly onActivity = () => {}) {}
  report(report: PresenceReport): void {
    const previous = this.screens.get(report.screen);
    if (previous && report.seq <= previous.seq) return;
    const elapsed = this.elapsed();
    const newTouch = report.touchedAgo !== null && (!previous || report.touchSeq > previous.touchSeq);
    // Arrival cannot renew a repeated touch, nor move a page's later touch behind its earlier one.
    const touchedAt = newTouch && report.touchedAgo !== null
      ? Math.max(elapsed - report.touchedAgo, previous?.touchedAt ?? -Infinity) : previous?.touchedAt ?? null;
    if (touchedAt === null || touchedAt < this.oldestTouch) return;
    this.screens.set(report.screen, { seq: report.seq, touchSeq: report.touchSeq, touchedAt });
    if (newTouch) this.onActivity();
    if (touchedAt < this.manualAwayUntil) return;
    const latest = this.latest;
    if (latest && (touchedAt < latest.touchedAt ||
      (touchedAt === latest.touchedAt && report.screen < latest.screen))) return;
    const sameLeave = !newTouch && latest?.screen === report.screen && latest.hiddenAt !== null;
    const hiddenAt = report.hiddenAgo === null ? null : sameLeave ? latest.hiddenAt : elapsed - report.hiddenAgo;
    this.latest = { screen: report.screen, touchedAt, hiddenAt };
    // Keep the cutoff after manual away too: forgotten reports must stay too old to restore presence.
    this.oldestTouch = Math.max(this.oldestTouch, touchedAt - MAX_IDLE);
    for (const [screen, state] of this.screens) if (state.touchedAt < this.oldestTouch) this.screens.delete(screen);
  }
  away(): void {
    this.latest = null;
    this.manualAwayUntil = this.elapsed() + MINUTE;
  }
  status(settings: SettingValues, now = Date.now()): PresenceStatus {
    return presenceStatus(this.latest, settings, this.elapsed(), now);
  }
}
