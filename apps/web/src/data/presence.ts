import { trackedFetch } from './request-activity';
import { problemSchema } from '@alpacawork/contract/problem';
import { apiError, mutationHeaders, requireWriteAccess } from './client';
import { recordFailure } from '@/lib/notify';
import { isAgentView } from '@/lib/agent-view';
import { canSendWrites, useConnection } from './connection';
import { useEffect, useState } from 'react';
import type { PresenceReport } from '@alpacawork/contract/inputs';

/**
 * Activity and durable pause/resume share the JSON API's send boundary; no offline intent is queued. A `?agent=1` page
 * is an agent checking the screen, not the person: its activity would hold back the person's notifications and count
 * as a day of use, so it is not sent.
 */
export async function postPresence(path: string, body?: object, acceptUnconfirmed = false, keepalive = false) {
  if (path === '' && isAgentView()) return;
  // A refused send never reached serve and must not be reported as an uncertain committed operation.
  requireWriteAccess();
  const headers=mutationHeaders(undefined,undefined,body?{'Content-Type':'application/json'}:{});
  let response: Response;
  try {
    response = await trackedFetch(`/api/presence${path}`, { method: 'POST', headers, keepalive,
      ...(body ? { body: JSON.stringify(body) } : {}) });
  } catch (error) {
    if (acceptUnconfirmed) { recordFailure(error, `presence ${path}`); return; }
    throw error;
  }
  if (!response.ok) {
    const problem = problemSchema.safeParse(await response.json().catch(() => null));
    throw problem.success ? apiError(problem.data.error) : new Error(`Presence request failed: HTTP ${response.status}`);
  }
}

const REPORT_INTERVAL = 15_000;
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/**
 * One page owns its event times and reports its current state. A report that could not be sent is not queued: the next
 * report, or the one sent when write access recovers, carries the state as it is then.
 */
class ScreenPresence {
  private readonly screen = crypto.randomUUID();
  private seq = 0;
  private touchSeq = 0;
  private revision = 0;
  private confirmed = 0;
  private touchedAt: number | null = null;
  private hiddenAt: number | null = document.visibilityState === 'hidden' ? performance.now() : null;
  private lastSent = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private send = (keepalive = false): Promise<void> => {
    clearTimeout(this.timer); this.timer = undefined;
    const now = performance.now();
    this.lastSent = now;
    const report: PresenceReport = { screen: this.screen, seq: ++this.seq, touchSeq: this.touchSeq,
      touchedAgo: this.touchedAt === null ? null : now - this.touchedAt,
      hiddenAgo: this.hiddenAt === null ? null : now - this.hiddenAt };
    const revision = this.revision;
    return postPresence('', report, false, keepalive).then(() => {
      // A delayed answer confirms only the state it sent, never a newer touch or leave.
      this.confirmed = Math.max(this.confirmed, revision);
    });
  };
  /** Sends the current state when writes are allowed; otherwise it stays unconfirmed until they are. */
  private report = (keepalive = false) => {
    if (canSendWrites()) void this.send(keepalive).catch((error: unknown) => recordFailure(error, 'presence activity'));
  };
  private touched = () => {
    this.touchedAt = performance.now();
    this.touchSeq++;
    this.hiddenAt = null;
    this.revision++;
  };
  /** The first touch is reported at once; later ones within the interval share one trailing report. */
  private input = () => {
    if (document.visibilityState !== 'visible') return;
    this.touched();
    const remaining = REPORT_INTERVAL - (performance.now() - this.lastSent);
    if (remaining <= 0) this.report();
    else this.timer ??= setTimeout(() => { this.timer = undefined; this.report(); }, remaining);
  };
  private hide = () => {
    this.hiddenAt ??= performance.now();
    this.revision++;
    this.report(true);
  };
  /** Bringing the page back to the front is a touch; loading it is not. */
  private show = () => {
    if (this.hiddenAt === null || document.visibilityState !== 'visible') return;
    this.touched();
    this.report();
  };
  private visibility = () => { if (document.visibilityState === 'hidden') this.hide(); else this.show(); };
  /** The person says they are here: a touch whose refusal they must see. */
  present = (): Promise<void> => {
    this.touched();
    return this.send();
  };
  start = () => {
    let writable = canSendWrites();
    const stopConnection = useConnection.subscribe(() => {
      const next = canSendWrites(), recovered = next && !writable;
      writable = next;
      if (recovered && this.revision > this.confirmed) this.report(this.hiddenAt !== null);
    });
    for (const event of INPUT_EVENTS) document.addEventListener(event, this.input, { passive: true });
    document.addEventListener('visibilitychange', this.visibility);
    window.addEventListener('pagehide', this.hide);
    window.addEventListener('pageshow', this.show);
    return () => {
      clearTimeout(this.timer); this.timer = undefined;
      stopConnection();
      for (const event of INPUT_EVENTS) document.removeEventListener(event, this.input);
      document.removeEventListener('visibilitychange', this.visibility);
      window.removeEventListener('pagehide', this.hide);
      window.removeEventListener('pageshow', this.show);
    };
  };
}

/** Reports this page's presence while mounted; returns the menu's "Present" action. */
export function usePresenceActivity() {
  const [screen] = useState(() => new ScreenPresence());
  useEffect(screen.start, [screen]);
  return screen.present;
}
