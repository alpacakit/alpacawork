import { AUTOMATION_SDK_CONTRACT_VERSION, type ProgramAutomationEvent } from '@alpacawork/contract/automation-program';
import { type ChangeLog } from '@alpacawork/db';
import type { HostPressureObservation } from '../host/monitor.js';
import { readTallyScope } from '../analysis/tally-scope.js';
import { taskEventTail } from '../control/task-history.js';
import { advanceEvents, eventCursor, readTaskEvents, type TaskEvent } from './events.js';
import type { HostPressureWindow } from './host-trigger.js';
import { bundleEventReader } from './bundle-readers.js';
import { bundleNowWrite } from './bundle-runtime.js';
import { bundleLimit, enqueueBundleRun, pruneBundleHistory } from './bundle-runs.js';
import { bundleLifecycle, bundleVersion, listBundleAutomations } from './bundle-store.js';

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
        const context = { db, automation, version, now, start, tail, tallySince, pressure: this.pressure,
          read: (sequence: number) => {
            if (!events.has(sequence)) events.set(sequence, readTaskEvents(db, sequence));
            return events.get(sequence)!;
          },
          admit: (event: ProgramAutomationEvent, refusal?: ReturnType<typeof bundleLimit>) => {
            enqueueBundleRun(db, automation, version.digest, event, 'live', now, refusal ?? bundleLimit(db, automation, version.config, now));
          },
        };
        bundleEventReader(version.config.on).scan(context);
      }
      if (tail > start) advanceEvents(db, tail);
      if (now.getTime() - this.lastPrune >= 60 * 60_000) {
        pruneBundleHistory(db, now);
        this.lastPrune = now.getTime();
      }
    }));
    this.wakeRuntime();
  }
}
