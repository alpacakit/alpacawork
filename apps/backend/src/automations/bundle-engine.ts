import type { DatabaseSync } from 'node:sqlite';
import { AUTOMATION_SDK_CONTRACT_VERSION, automationEvents, type ProgramAutomationEvent } from '@alpacawork/contract/automation-program';
import { type ChangeLog } from '@alpacawork/db';
import type { HostPressureObservation } from '../host/monitor.js';
import { readTallyScope } from '../analysis/tally-scope.js';
import { taskEventTail } from '../control/task-history.js';
import { advanceEvents, eventCursor, readTaskEvents, type TaskEvent } from './events.js';
import { matchHostPressure, type HostPressureWindow } from './host-trigger.js';
import { bundleTaskMatch, programTaskEvent } from './bundle-events.js';
import { bundleNowWrite } from './bundle-runtime.js';
import { bundleLimit, enqueueBundleRun, pruneBundleHistory, settleBundleRun, touchBundleRun } from './bundle-runs.js';
import { bundleLifecycle, bundleVersion, listBundleAutomations, type BundleAutomation } from './bundle-store.js';
import { nextAutomationTimes } from './schedule.js';

const EVENT_BATCH = 128;
type OrderedWrite = <T>(work: () => T | Promise<T>) => Promise<T>;

export class BundleEngine {
  private pressure: HostPressureWindow | null = null;
  private lastPrune = 0;
  private scheduled = false;
  private closed = false;
  private unsubscribe: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly root: string, readonly orderedWrite: OrderedWrite, readonly wakeRuntime: () => void,
    readonly now = () => new Date()) {}

  observePressure(observation: HostPressureObservation | null): boolean {
    if (!observation || observation.episodeStart === null) {
      this.pressure = null;
      return false;
    }
    const previous = this.pressure?.observation.episodeStart === observation.episodeStart
      ? new Map(this.pressure.enteredAt) : new Map<HostPressureObservation['kinds'][number], number>();
    for (const kind of previous.keys()) if (!observation.kinds.includes(kind)) previous.delete(kind);
    for (const kind of observation.entered) previous.set(kind, observation.at);
    this.pressure = { observation, enteredAt: previous };
    this.kick();
    return observation.kinds.length > 0;
  }

  start(log: ChangeLog) {
    this.unsubscribe = log.subscribe(() => this.kick());
    this.timer = setInterval(() => this.kick(), 1_000);
    this.timer.unref();
    this.kick();
  }

  close() { this.closed = true; this.unsubscribe?.(); clearInterval(this.timer); }
  tallied() { this.kick(); }

  kick(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    const timer = setTimeout(() => {
      void this.scan().catch(error => console.error('Automation event scan failed', error))
        .finally(() => { this.scheduled = false; });
    }, 25);
    timer.unref();
  }

  async scan() {
    if (this.closed) return;
    const now = this.now();
    const tallySince = readTallyScope(this.root);
    await this.orderedWrite(() => bundleNowWrite(this.root, db => {
      const automations = listBundleAutomations(db, null).filter(automation => automation.enabled);
      const active = automations.map(automation => ({ automation, version: bundleVersion(db, automation.uuid, automation.live!) }));
      const at = now.toISOString();
      const start = eventCursor(db), tail = Math.min(taskEventTail(db), start + EVENT_BATCH);
      const events = new Map<number, TaskEvent[]>();
      for (const { automation, version } of active) {
        if (version.contractVersion !== AUTOMATION_SDK_CONTRACT_VERSION) {
          bundleLifecycle(db, this.root, automation, { kind: 'disabled', reason: 'program_contract_changed' }, { kind: 'system' }, now);
          continue;
        }
        const { on } = version.config, owner = automation.uuid;
        switch (automationEvents[on.event].source) {
          case 'schedule': {
            if (on.event !== 'schedule' || !automation.nextAt || automation.nextAt > at) break;
            const scheduledAt = automation.nextAt;
            const next = nextAutomationTimes(on.where.cron, version.config.timezone, now)[0];
            if (!next) break;
            if (!db.prepare('UPDATE automations SET next_at=? WHERE id=? AND live_digest=? AND next_at=?')
              .run(next, owner, version.digest, scheduledAt).changes) break;
            const event: ProgramAutomationEvent = { kind: 'schedule', ref: scheduledAt, at: scheduledAt, scheduledAt, manual: false };
            this.admit(db, automation, version, event, now);
            break;
          }
          case 'task_event': {
            const read = (sequence: number) => {
              if (!events.has(sequence)) events.set(sequence, readTaskEvents(db, sequence));
              return events.get(sequence)!;
            };
            const after = automation.eventAfter ?? tail;
            // A deferred event preserves per-automation ordering while unrelated subscriptions keep scanning.
            const deferred = db.prepare('SELECT event_sequence FROM automation_pending_skill_events WHERE automation_id=? ORDER BY event_sequence')
              .all(owner).map(row => Number(row.event_sequence));
            for (const sequence of new Set([...deferred, ...Array.from({ length: Math.max(0, tail - Math.max(start, after)) },
              (_, index) => Math.max(start, after) + index + 1)])) {
              const found = read(sequence).find(event => event.project === automation.project && (
                on.event === 'task.message' ? event.event === 'message_received' : event.event === 'state_changed'));
              const event = found && programTaskEvent(db, found);
              const match = found && event ? bundleTaskMatch(db, version.config, event, found, tallySince, now) : 'miss';
              if (match === 'pending') {
                db.prepare(`INSERT OR IGNORE INTO automation_pending_skill_events(automation_id,event_sequence) VALUES (?,?)`).run(owner, sequence);
                // This event will be retried even after the global cursor passes it.
                for (let later = sequence + 1; later <= tail; later++)
                  if (read(later).some(event => event.project === automation.project))
                    db.prepare('INSERT OR IGNORE INTO automation_pending_skill_events VALUES (?,?)').run(owner, later);
                break;
              }
              db.prepare('DELETE FROM automation_pending_skill_events WHERE automation_id=? AND event_sequence=?').run(owner, sequence);
              db.prepare('UPDATE automations SET event_after=max(event_after,?) WHERE id=? AND live_digest=?').run(sequence, owner, version.digest);
              if (event && (match === 'match' || match === 'unavailable')) this.admit(db, automation, version, event, now,
                match === 'unavailable' ? { kind: 'skill_usage_unavailable', reason: 'Could not confirm the skills used for this event' } : null);
            }
            break;
          }
          case 'signal': {
            const row = db.prepare("SELECT number,digest,expires_at FROM automation_runs WHERE automation_id=? AND state='waiting'").get(owner);
            if (!row) break;
            const number = Number(row.number);
            if (String(row.expires_at) <= at || row.digest !== version.digest) {
              settleBundleRun(db, automation, number, now, { state: 'skipped',
                kind: row.digest === version.digest ? 'signal_expired' : 'definition_changed', reason: 'The pending signal is no longer current' });
              break;
            }
            const refusal = bundleLimit(db, automation, version.config, now);
            if (refusal?.kind === 'cooldown' || refusal?.kind === 'previous_task_active' || refusal?.kind === 'previous_task_failed') break;
            if (refusal) {
              settleBundleRun(db, automation, number, now, { state: 'skipped', ...refusal });
              break;
            }
            if (db.prepare("SELECT 1 FROM automation_runs WHERE automation_id=? AND state='running'").get(owner)) break;
            db.prepare("UPDATE automation_runs SET state='running',phase='trigger',expires_at=NULL,version=version+1 WHERE automation_id=? AND number=?")
              .run(owner, number);
            // The 60-second slot timer starts only when the coalesced signal can enter the queue.
            db.prepare("UPDATE automation_runs SET phase_started_at=? WHERE automation_id=? AND number=?").run(at, owner, number);
            touchBundleRun(db, automation, number);
            break;
          }
          case 'host_pressure': {
            if (on.event !== 'host.pressure') break;
            const match = matchHostPressure(automation, on,
              this.pressure, now);
            if (!match) break;
            db.prepare('UPDATE automations SET host_pressure_cursor=? WHERE id=? AND live_digest=?')
              .run(JSON.stringify(match.cursor), owner, version.digest);
            const recorded = new Date(match.observation.at).toISOString();
            this.admit(db, automation, version, { kind: 'host.pressure', ref: match.key, at: recorded, manual: false, kinds: match.kinds,
              phase: match.key.startsWith('entry:') ? 'entered' : 'continuing', episodeStartedAt: new Date(match.episodeStart).toISOString() }, now);
            break;
          }
        }
      }
      if (tail > start) advanceEvents(db, tail);
      if (now.getTime() - this.lastPrune >= 60 * 60_000) {
        pruneBundleHistory(db, now);
        this.lastPrune = now.getTime();
      }
    }));
    this.wakeRuntime();
  }

  private admit(db: DatabaseSync, automation: BundleAutomation, version: ReturnType<typeof bundleVersion>, event: ProgramAutomationEvent,
    now: Date, refusal?: ReturnType<typeof bundleLimit>) {
    enqueueBundleRun(db, automation, version.digest, event, 'live', now, refusal ?? bundleLimit(db, automation, version.config, now));
  }
}
