import type { DatabaseSync } from 'node:sqlite';
import { automationEventMatches, automationEventSchema, automationEvents, type AutomationConfig, type ProgramAutomationEvent, type ProgramAutomationOn } from '@alpacawork/contract/automation-program';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { matchTaskSkills } from '../analysis/run-skills.js';
import { readTallyScope } from '../analysis/tally-scope.js';
import { recentTaskEvents, readTaskEventReference, type TaskEvent } from './events.js';
import { nextAutomationTimes } from './schedule.js';
import { readBundleEvent } from './bundle-runs.js';
import type { BundleAutomation } from './bundle-store.js';

type TaskProgramEvent = Extract<ProgramAutomationEvent, { task: unknown }>;
const WEEK_MS = 7 * 86_400_000;

export function wordsPrefix(value: string, bytes: number) {
  const encoded = Buffer.from(value);
  if (encoded.length <= bytes) return { text: value, truncated: false };
  let end = bytes;
  while ((encoded[end]! & 0xc0) === 0x80) end--;
  return { text: encoded.subarray(0, end).toString('utf8'), truncated: true };
}

export function programTaskEvent(db: DatabaseSync, on: ProgramAutomationOn, source: TaskEvent): TaskProgramEvent | null {
  const reader = automationEvents[on.event];
  if (reader.taskRecord?.event !== source.event) return null;
  const fields = Object.fromEntries(reader.taskRecord.fields.map(field => [field, source[field as keyof TaskEvent]]));
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
  const event = reader.event.parse({ ...common, ...fields, kind: on.event });
  return 'task' in event ? event : null;
}

export function bundleTaskMatch(db: DatabaseSync, config: AutomationConfig, event: TaskProgramEvent, row: TaskEvent,
  tallySince: number | null, now: Date): 'match' | 'miss' | 'pending' | 'unavailable' {
  const { on } = config;
  if (!automationEventMatches(on, event, row)) return 'miss';
  const skills = on.where && 'skills' in on.where ? on.where.skills : undefined;
  if (!skills) return 'match';
  const deadline = Date.parse(event.at) + 60_000;
  const result = matchTaskSkills(db, event.task.id, event.at, tallySince, skills, deadline);
  return result === 'match' || result === 'miss' ? result : result === 'pending' && now.getTime() < deadline ? 'pending' : 'unavailable';
}

export const signalFilterMiss = { kind: 'event_not_matched', reason: 'The signal did not match the event filter' } as const;

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
  if (choice.event === undefined) return automationEvents[on.event].manual?.(now.toISOString()) ?? null;
  for (const event of candidateEvents(db, root, config, project, automation, now, choice.event)) return event;
  throw new Problem(PROBLEM_CODE.notFound, 'Choose a recent matching event');
}

export function bundleScheduleTimes(config: AutomationConfig, now: Date) {
  const { where } = config.on;
  if (!where || !('cron' in where)) throw new Error('A schedule reader requires a cron expression');
  return nextAutomationTimes(where.cron, config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, now);
}

function* candidateEvents(db: DatabaseSync, root: string, config: AutomationConfig, project: string,
  automation: BundleAutomation | null, now: Date, ref?: string): Iterable<ProgramAutomationEvent> {
  const { on } = config, row = automationEvents[on.event];
  const since = new Date(now.getTime() - WEEK_MS).toISOString();
  switch (row.candidates) {
    case 'next': {
      const time = ref === undefined ? bundleScheduleTimes(config, now)[0] : ref;
      if (time && Number.isFinite(Date.parse(time))) {
        const event = row.manual?.(new Date(time).toISOString());
        if (event && automationEventMatches(on, event)) yield event;
      }
      break;
    }
    case 'task': {
      const tallySince = readTallyScope(root);
      const rows = ref === undefined ? recentTaskEvents(db, project, since, now.toISOString()) : readTaskEventReference(db, project, ref);
      for (const source of rows) {
        if (source.at < since) continue;
        const event = programTaskEvent(db, on, source);
        if (event && bundleTaskMatch(db, config, event, source, tallySince, now) === 'match') yield { ...event, manual: true };
      }
      break;
    }
    case 'retained': {
      if (!automation) break;
      for (const run of db.prepare(`SELECT number FROM automation_runs WHERE automation_id=? AND trigger_kind=? AND mode='live'
        AND last_at>=? AND (? IS NULL OR trigger_ref=? OR 'run:' || number=?) ORDER BY number DESC`)
        .iterate(automation.uuid, on.event, since, ref ?? null, ref ?? null, ref ?? null)) {
        const event = readBundleEvent(db, { uuid: automation.uuid, number: Number(run.number) });
        if (event && automationEventMatches(on, event)) yield { ...event, manual: true };
      }
      break;
    }
  }
}

export function bundleEventCandidates(db: DatabaseSync, root: string, config: AutomationConfig, project: string,
  automation: BundleAutomation | null, now: Date): ProgramAutomationEvent[] {
  const events: ProgramAutomationEvent[] = [];
  for (const event of candidateEvents(db, root, config, project, automation, now)) {
    events.push(event);
    if (events.length === 5) break;
  }
  return events;
}
