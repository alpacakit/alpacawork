import type { DatabaseSync } from 'node:sqlite';
import {
  automationEventMatches, automationEvents, type AutomationConfig, type ProgramAutomationEvent, type ProgramAutomationOn,
} from '@alpacawork/contract/automation-program';
import { taskEventTail } from '../control/task-history.js';
import { bundleScheduleTimes, bundleTaskMatch, programTaskEvent, signalFilterMiss } from './bundle-events.js';
import { bundleLimit, readBundleEvent, settleBundleRun, touchBundleRun, type BundleRefusal } from './bundle-runs.js';
import type { BundleAutomation, PreparedAutomationVersion } from './bundle-store.js';
import type { TaskEvent } from './events.js';
import { matchHostPressure, type HostPressureWindow } from './host-trigger.js';

type Position = {
  next: string | null; after: number | null; hostAfter: string | null; hostCursor: BundleAutomation['hostPressureCursor'];
};
type Scan = {
  db: DatabaseSync; automation: BundleAutomation; version: PreparedAutomationVersion; now: Date;
  start: number; tail: number; tallySince: number | null; pressure: HostPressureWindow | null;
  read: (sequence: number) => TaskEvent[];
  admit: (event: ProgramAutomationEvent, refusal?: BundleRefusal | null) => void;
};
type Reader = {
  start?: (db: DatabaseSync, config: AutomationConfig, now: Date) => Partial<Position>;
  scan: (context: Scan) => void;
};

const readers: Record<(typeof automationEvents)[ProgramAutomationOn['event']]['source'], Reader> = {
  schedule: {
    start: (_db, config, now) => ({ next: bundleScheduleTimes(config, now)[0] ?? null }),
    scan: ({ db, automation, version, now, admit }) => {
      const scheduledAt = automation.nextAt;
      if (!scheduledAt || scheduledAt > now.toISOString()) return;
      const next = bundleScheduleTimes(version.config, now)[0];
      if (!next) return;
      const on = version.config.on;
      const event = automationEvents[on.event].manual?.(scheduledAt);
      if (!event) throw new Error('A schedule reader requires an event for its due time');
      if (!db.prepare('UPDATE automations SET next_at=? WHERE id=? AND live_digest=? AND next_at=?')
        .run(next, automation.uuid, version.digest, scheduledAt).changes) return;
      const due = { ...event, manual: false };
      if (automationEventMatches(on, due)) admit(due);
    },
  },
  task_event: {
    start: db => ({ after: taskEventTail(db) }),
    scan: ({ db, automation, version, now, read, start, tail, tallySince, admit }) => {
      const owner = automation.uuid, after = automation.eventAfter ?? tail;
      const deferred = db.prepare('SELECT event_sequence FROM automation_pending_skill_events WHERE automation_id=? ORDER BY event_sequence')
        .all(owner).map(row => Number(row.event_sequence));
      const fresh = Array.from({ length: Math.max(0, tail - Math.max(start, after)) }, (_, index) => Math.max(start, after) + index + 1);
      for (const sequence of new Set([...deferred, ...fresh])) {
        let pending = false;
        for (const row of read(sequence)) {
          if (row.project !== automation.project) continue;
          const event = programTaskEvent(db, version.config.on, row);
          if (!event) continue;
          const match = bundleTaskMatch(db, version.config, event, row, tallySince, now);
          if (match === 'pending') {
            // Preserve this automation's ordering while the shared cursor and other readers move on.
            for (let later = sequence; later <= tail; later++)
              if (read(later).some(event => event.project === automation.project))
                db.prepare('INSERT OR IGNORE INTO automation_pending_skill_events(automation_id,event_sequence) VALUES (?,?)').run(owner, later);
            pending = true;
            break;
          }
          if (match === 'match' || match === 'unavailable') admit(event,
            match === 'unavailable' ? { kind: 'skill_usage_unavailable', reason: 'Could not confirm the skills used for this event' } : null);
        }
        if (pending) break;
        db.prepare('DELETE FROM automation_pending_skill_events WHERE automation_id=? AND event_sequence=?').run(owner, sequence);
        db.prepare('UPDATE automations SET event_after=max(event_after,?) WHERE id=? AND live_digest=?').run(sequence, owner, version.digest);
      }
    },
  },
  signal: {
    scan: ({ db, automation, version, now }) => {
      const owner = automation.uuid, at = now.toISOString();
      const row = db.prepare("SELECT number,digest,expires_at FROM automation_runs WHERE automation_id=? AND state='waiting'").get(owner);
      if (!row) return;
      const number = Number(row.number);
      if (String(row.expires_at) <= at || row.digest !== version.digest) {
        settleBundleRun(db, automation, number, now, { state: 'skipped',
          kind: row.digest === version.digest ? 'signal_expired' : 'definition_changed', reason: 'The pending signal is no longer current' });
        return;
      }
      const event = readBundleEvent(db, { uuid: owner, number });
      if (!event) {
        settleBundleRun(db, automation, number, now, { state: 'failed', kind: 'signal_data_missing',
          reason: 'The saved signal data is missing', failedPhase: 'trigger' });
        return;
      }
      if (!automationEventMatches(version.config.on, event)) {
        settleBundleRun(db, automation, number, now, { state: 'skipped', ...signalFilterMiss });
        return;
      }
      const refusal = bundleLimit(db, automation, version.config, now);
      if (refusal?.kind === 'cooldown' || refusal?.kind === 'previous_task_active' || refusal?.kind === 'previous_task_failed') return;
      if (refusal) {
        settleBundleRun(db, automation, number, now, { state: 'skipped', ...refusal });
        return;
      }
      if (db.prepare("SELECT 1 FROM automation_runs WHERE automation_id=? AND state='running'").get(owner)) return;
      db.prepare("UPDATE automation_runs SET state='running',phase='trigger',expires_at=NULL,version=version+1 WHERE automation_id=? AND number=?")
        .run(owner, number);
      // The slot timer starts when the coalesced signal can enter the queue.
      db.prepare("UPDATE automation_runs SET phase_started_at=? WHERE automation_id=? AND number=?").run(at, owner, number);
      touchBundleRun(db, automation, number);
    },
  },
  host_pressure: {
    start: (_db, _config, now) => ({ hostAfter: now.toISOString() }),
    scan: ({ db, automation, version, now, pressure, admit }) => {
      const on = version.config.on;
      if (!on.where || !('kinds' in on.where)) throw new Error('A host pressure reader requires a list of pressure kinds');
      const match = matchHostPressure(automation, on.where.kinds, pressure, now);
      if (!match) return;
      const event = automationEvents[on.event].event.parse({
        kind: on.event, ref: match.key, at: new Date(match.observation.at).toISOString(), manual: false, kinds: match.kinds,
        phase: match.key.startsWith('entry:') ? 'entered' : 'continuing', episodeStartedAt: new Date(match.episodeStart).toISOString(),
      });
      db.prepare('UPDATE automations SET host_pressure_cursor=? WHERE id=? AND live_digest=?')
        .run(JSON.stringify(match.cursor), automation.uuid, version.digest);
      if (automationEventMatches(on, event)) admit(event);
    },
  },
};

export const bundleEventReader = (on: ProgramAutomationOn): Reader => readers[automationEvents[on.event].source];

export function startingBundlePosition(reader: Reader, db: DatabaseSync, config: AutomationConfig, now: Date): Position {
  return { next: null, after: null, hostAfter: null, hostCursor: null, ...reader.start?.(db, config, now) };
}
