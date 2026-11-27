import type { DatabaseSync } from 'node:sqlite';
import { automationEventSchema, automationEvents, type AutomationConfig, type ProgramAutomationEvent } from '@alpacawork/contract/automation-program';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { matchTaskSkills } from '../analysis/run-skills.js';
import { readTallyScope } from '../analysis/tally-scope.js';
import { recentTaskEvents, readTaskEventReference, type TaskEvent } from './events.js';
import { nextAutomationTimes } from './schedule.js';
import { readBundleEvent } from './bundle-runs.js';
import type { BundleAutomation } from './bundle-store.js';

type TaskProgramEvent = Extract<ProgramAutomationEvent, { kind: 'task.state_changed' | 'task.message' }>;

export function wordsPrefix(value: string, bytes: number) {
  const encoded = Buffer.from(value);
  if (encoded.length <= bytes) return { text: value, truncated: false };
  let end = bytes;
  while ((encoded[end]! & 0xc0) === 0x80) end--;
  return { text: encoded.subarray(0, end).toString('utf8'), truncated: true };
}

export function programTaskEvent(db: DatabaseSync, source: TaskEvent): TaskProgramEvent {
  const entry = db.prepare(`SELECT json_extract(l.entry,'$.origin') AS origin,t.base_state
    FROM tasks t LEFT JOIN task_log l ON l.task_id=t.id AND l.ordinal=0 WHERE t.external_id=?`).get(source.fields['task.id']!);
  const origin = typeof entry?.origin === 'string' ? JSON.parse(entry.origin) : null;
  const text = wordsPrefix(source.description, 65_536);
  const common = {
    ref: source.key, at: source.at, manual: false, title: source.title, description: text.text,
    ...(text.truncated ? { descriptionTruncated: true as const } : {}),
    task: { id: source.fields['task.id']!, title: source.fields['task.title']!, state: source.fields['task.state'] || entry?.base_state,
      userRequested: source.userRequested, origin: origin && { automationId: origin.automationId, name: origin.name, runNumber: origin.runNumber } },
  };
  return automationEventSchema.parse(source.event === 'state_changed'
    ? { ...common, kind: 'task.state_changed', from: source.from, to: source.to }
    : { ...common, kind: 'task.message', by: source.by, type: source.type }) as TaskProgramEvent;
}

export function bundleTaskMatch(db: DatabaseSync, config: AutomationConfig, event: TaskProgramEvent, row: TaskEvent,
  tallySince: number | null, now: Date): 'match' | 'miss' | 'pending' | 'unavailable' {
  const { on } = config;
  if (row.automated && !(on.where && 'includeAutomated' in on.where && on.where.includeAutomated)) return 'miss';
  if (on.event === 'task.message' && event.kind === on.event)
    return automationEvents[on.event].matches(on.where, { ...event, description: row.description }) ? 'match' : 'miss';
  if (on.event !== 'task.state_changed' || event.kind !== on.event || !automationEvents[on.event].matches(on.where, event)) return 'miss';
  if (!on.where.skills) return 'match';
  const deadline = Date.parse(event.at) + 60_000;
  const result = matchTaskSkills(db, event.task.id, event.at, tallySince, on.where.skills, deadline);
  return result === 'match' || result === 'miss' ? result : result === 'pending' && now.getTime() < deadline ? 'pending' : 'unavailable';
}

type EventSource = { event?: string; syntheticEvent?: unknown };
export function bundleEventChoice(db: DatabaseSync, root: string, config: AutomationConfig, project: string,
  automation: BundleAutomation | null, choice: EventSource, now: Date): ProgramAutomationEvent | null {
  const { on } = config;
  if (choice.syntheticEvent !== undefined) {
    const source = choice.syntheticEvent;
    const parsed = automationEventSchema.parse(source && typeof source === 'object' && !Array.isArray(source)
      ? { ...source, manual: true } : source);
    if (parsed.kind !== on.event) throw new Problem(PROBLEM_CODE.invalidInput, 'Use the event kind declared in config');
    if ('task' in parsed) {
      const task = db.prepare(`SELECT p.external_id AS project FROM tasks t JOIN tasks p ON p.id=t.project_task_id WHERE t.external_id=?`).get(parsed.task.id);
      if (task?.project !== project) throw new Problem(PROBLEM_CODE.notFound, 'The event task does not exist in this project');
    }
    return parsed;
  }
  if (choice.event !== undefined) {
    const chosen = choice.event;
    if (automationEvents[on.event].candidates === 'task') {
      const tallySince = readTallyScope(root);
      for (const row of readTaskEventReference(db, project, chosen)) {
        if (Date.parse(row.at) < now.getTime() - 7 * 86_400_000) continue;
        const event = programTaskEvent(db, row);
        if (bundleTaskMatch(db, config, event, row, tallySince, now) === 'match') return { ...event, manual: true };
      }
    } else if (automation && automationEvents[on.event].candidates === 'retained') {
      const row = db.prepare(`SELECT number FROM automation_runs WHERE automation_id=? AND mode='live' AND trigger_kind=?
        AND (trigger_ref=? OR 'run:' || number=?) AND last_at>=? ORDER BY number DESC LIMIT 1`)
        .get(automation.uuid, on.event, chosen, chosen, new Date(now.getTime() - 7 * 86_400_000).toISOString());
      const event = row && readBundleEvent(db, { uuid: automation.uuid, number: Number(row.number) });
      if (event && (on.event !== 'host.pressure' || event.kind === on.event && automationEvents[on.event].matches(on.where, event)))
        return { ...event, manual: true };
    } else if (on.event === 'schedule') {
      const at = Date.parse(chosen);
      if (Number.isFinite(at)) return automationEvents.schedule.manual(new Date(at).toISOString());
    }
    throw new Problem(PROBLEM_CODE.notFound, 'Choose a recent matching event');
  }
  return on.event === 'schedule' ? automationEvents.schedule.manual(now.toISOString()) : null;
}

export function bundleEventCandidates(db: DatabaseSync, root: string, config: AutomationConfig, project: string,
  automation: BundleAutomation | null, now: Date): ProgramAutomationEvent[] {
  const { on } = config;
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  if (on.event === 'schedule') {
    const at = nextAutomationTimes(on.where.cron, config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, now)[0];
    return at ? [automationEvents.schedule.manual(at)] : [];
  }
  const events: ProgramAutomationEvent[] = [];
  if (automationEvents[on.event].candidates === 'task') {
    const tallySince = readTallyScope(root);
    for (const row of recentTaskEvents(db, project, since, now.toISOString())) {
      const event = programTaskEvent(db, row);
      if (bundleTaskMatch(db, config, event, row, tallySince, now) !== 'match') continue;
      events.push({ ...event, manual: true });
      if (events.length === 5) break;
    }
  } else if (automation) {
    for (const row of db.prepare(`SELECT number FROM automation_runs WHERE automation_id=? AND trigger_kind=? AND mode='live'
      AND last_at>=? ORDER BY number DESC`).iterate(automation.uuid, on.event, since)) {
      const event = readBundleEvent(db, { uuid: automation.uuid, number: Number(row.number) });
      if (!event || on.event === 'host.pressure' && (event.kind !== on.event || !automationEvents[on.event].matches(on.where, event))) continue;
      events.push({ ...event, manual: true });
      if (events.length === 5) break;
    }
  }
  return events;
}
