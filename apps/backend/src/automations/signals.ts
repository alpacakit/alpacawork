import { automationEventMatches, automationEvents } from '@alpacawork/contract/automation-program';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  AUTOMATION_SIGNAL_DATA_BYTES, AUTOMATION_SIGNAL_DEPTH, type AutomationSignalData, type AutomationSignalResult, type SignalSender,
} from '@alpacawork/contract/automation';
import type { CommandInput } from '@alpacawork/contract/commands';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { touch } from '@alpacawork/db';
import { taskOrigin } from '@alpacawork/raw/task-log-schema';
import type { Caller } from '../control/authorize.js';
import { readTask } from '../control/task-store.js';
import { signalFilterMiss } from './bundle-events.js';
import { appendBundleSignal, bundleLimit, enqueueBundleRun } from './bundle-runs.js';
import { bundleVersion, readBundleAutomation, type BundleAutomation } from './bundle-store.js';

const MINUTE_MS = 60_000;
const MAX_TRIGGER_REQUESTS = { workspace: 60, automation: 12 };
const MAX_TRIGGER_RECEIPTS = { workspace: 32_768, automation: 2_048 };

function busy(message: string): never {
  throw new Problem(PROBLEM_CODE.busy, message);
}

/** Runs in the receiver before these requests enter its write queue. */
export class AutomationIngress {
  private minute = -1;
  private total = 0;
  private readonly counts = new Map<string, number>();

  take(id: string, tick = performance.now()): void {
    const minute = Math.floor(tick / MINUTE_MS);
    if (this.minute !== minute) {
      this.minute = minute;
      this.total = 0;
      this.counts.clear();
    }
    const count = this.counts.get(id) ?? 0;
    if (this.total >= MAX_TRIGGER_REQUESTS.workspace || count >= MAX_TRIGGER_REQUESTS.automation)
      busy('Automation trigger rate limit reached');
    this.total++;
    this.counts.set(id, count + 1);
  }
}

export function assertTriggerReceiptCapacity(db: DatabaseSync, automation: BundleAutomation): void {
  const operationCount = db.prepare(`SELECT count(*) AS total FROM cli_operations
    WHERE operation IN ('automation/signal','automation/run-now','automation/try')`).get()!;
  const automationCount = db.prepare(`SELECT count(*) AS total FROM cli_operations
    WHERE operation IN ('automation/signal','automation/run-now','automation/try') AND json_extract(response_json,'$.automation.id')=?`).get(automation.id)!;
  if (Number(operationCount.total) >= MAX_TRIGGER_RECEIPTS.workspace ||
      Number(automationCount.total) >= MAX_TRIGGER_RECEIPTS.automation)
    busy('Automation trigger operation receipts are full');
}

function assertSignalReceiptCapacity(db: DatabaseSync, automation: BundleAutomation): void {
  const signalCount = db.prepare('SELECT count(*) AS total FROM automation_signal_receipts').get()!;
  const signalAutomationCount = db.prepare('SELECT count(*) AS total FROM automation_signal_receipts WHERE automation_id=?').get(automation.uuid)!;
  if (Number(signalCount.total) >= MAX_TRIGGER_RECEIPTS.workspace ||
      Number(signalAutomationCount.total) >= MAX_TRIGGER_RECEIPTS.automation)
    busy('Automation signal receipts are full');
}

/** The envelope has already parsed as JSON. Count the original data object, including whitespace and escapes. */
export function assertRawSignalDataSize(source: string): void {
  let depth = 0, start = -1;
  for (const token of source.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]/g)) {
    const text = token[0], offset = token.index;
    if (text === '{' || text === '[') depth++;
    else if (text === '}' || text === ']') {
      depth--;
      if (depth === 1 && start >= 0) {
        if (Buffer.byteLength(source.slice(start, offset + 1)) > AUTOMATION_SIGNAL_DATA_BYTES)
          throw new Problem(PROBLEM_CODE.tooLarge, 'Signal data exceeds 64 KiB');
        start = -1;
      }
    } else if (depth === 1 && JSON.parse(text) === 'data') {
      const end = offset + text.length;
      const separator = /^\s*:\s*(?=\{)/.exec(source.slice(end));
      if (separator) start = end + separator[0].length;
    }
  }
}

/** Check nesting before Zod's recursive JSON decoder sees the request. */
export function assertSignalDepth(value: unknown, level = 1): void {
  if (!value || typeof value !== 'object') return;
  if (level > AUTOMATION_SIGNAL_DEPTH)
    throw new Problem(PROBLEM_CODE.tooDeep, 'Signal data is nested more than eight levels');
  for (const entry of Object.values(value)) assertSignalDepth(entry, level + 1);
}

export function canonicalTriggerJson(value: AutomationSignalData[string]): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTriggerJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalTriggerJson(value[key]!)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signalTarget(db: DatabaseSync, id: string, caller: Caller): string {
  const { project } = readBundleAutomation(db, id);
  if (caller.kind === 'run' && taskOrigin(readTask(db, caller.taskId, 'none').meta.log))
    throw new Problem(PROBLEM_CODE.forbidden, 'A Run of an automation-created task cannot send a signal',
      { action: 'automation.signal' });
  return project;
}

function signalSender(caller: Caller): SignalSender {
  if (caller.kind === 'program') throw new Problem(PROBLEM_CODE.forbidden, 'Automation programs cannot send signals');
  return caller.kind === 'run' ? { kind: 'task', taskId: caller.taskId } : { kind: caller.kind };
}

/** The caller has passed the command table in this same transaction, including for replays. */
export function receiveSignal(db: DatabaseSync, input: CommandInput<'automation/signal'>, caller: Caller, opId: string, now: Date): AutomationSignalResult {
  const automation = readBundleAutomation(db, input.automation);
  assertTriggerReceiptCapacity(db, automation);
  return acceptSignal(db, automation, input.data ?? null, signalSender(caller), input.key ?? opId, now, input.key ?? null);
}

/** HTTP hooks and commands both commit the signal and its retry receipt here. */
export function acceptSignal(db: DatabaseSync, automation: BundleAutomation, data: AutomationSignalData[string] | null,
  by: SignalSender, key: string, now: Date, publicKey: string | null = key): AutomationSignalResult {
  const reference = { id: automation.id, project: automation.project };
  assertSignalDepth(data);
  const payload = canonicalTriggerJson(data);
  if (Buffer.byteLength(payload) > AUTOMATION_SIGNAL_DATA_BYTES)
    throw new Problem(PROBLEM_CODE.tooLarge, 'Signal data exceeds 64 KiB');
  const delivery = createHash('sha256').update(key).digest('hex');
  const fingerprint = createHash('sha256').update(payload).digest('hex');
  const prior = db.prepare('SELECT * FROM automation_signal_receipts WHERE automation_id=? AND key=?').get(automation.uuid, delivery);
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Signal key belongs to different data');
    return { automation: reference, receipt: { id: String(prior.id), at: String(prior.at),
      status: prior.status as AutomationSignalResult['receipt']['status'],
      reasonKind: prior.reason_kind as AutomationSignalResult['receipt']['reasonKind'] }, duplicate: true };
  }
  if (!automation.live || automation.deleted)
    throw new Problem(PROBLEM_CODE.conflict, 'Only an enabled signal automation accepts signals');
  const version = bundleVersion(db, automation.uuid, automation.live);
  const kind = version.config.on.event, event = automationEvents[kind];
  if (event.source !== 'signal')
    throw new Problem(PROBLEM_CODE.conflict, 'Only an enabled signal automation accepts signals');
  assertSignalReceiptCapacity(db, automation);
  const at = now.toISOString(), id = randomUUID();
  const item = { at, by, key: publicKey, data };
  const signal = event.event.parse({ kind, ref: id, at, manual: false, count: 1, firstAt: at, lastAt: at, items: [item] });
  const limit = bundleLimit(db, automation, version.config, now);
  // A coalesced receipt may wait out the cooldown or the previous task; a single event is decided now.
  const refusal = !event.coalesce
    ? automationEventMatches(version.config.on, signal) ? limit : signalFilterMiss
    : limit?.kind === 'automation_expired' || limit?.kind === 'daily_limit' ? limit : null;
  const receipt = event.coalesce && !refusal ? appendBundleSignal(db, automation, kind, id, item, now)
    : { status: refusal ? 'skipped' as const : 'accepted' as const,
        number: enqueueBundleRun(db, automation, version.digest, signal, 'live', now, refusal).number };
  const reasonKind = refusal?.kind ?? null;
  db.prepare(`INSERT INTO automation_signal_receipts(automation_id,key,id,fingerprint,run_number,at,status,reason_kind,settled_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(automation.uuid, delivery, id, fingerprint, receipt.number, at, receipt.status, reasonKind, refusal ? at : null);
  if (!refusal) touch(db, { kind: 'automation_signal', id });
  return { automation: reference, receipt: { id, at, status: receipt.status, reasonKind }, duplicate: false };
}
