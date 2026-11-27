import { join } from 'node:path';
import { hasCode, publishImmutable, readImmutable } from '@alpacawork/core';
import { RUN_ENDED_STATES, RUN_STATE } from '@alpacawork/contract/run';

const marker = 'analysis-tally-since';
export const TALLY_STDOUT_BYTES = 128 * 1024 * 1024;

/** Initialize once under the workspace writer lease, before analysis reads or collects any tallies. */
export function openTallyScope(root: string): number {
  const directory = join(root, '.alpacawork');
  const existing = readTallyScope(root);
  if (existing !== null) return existing;
  const now = Date.now();
  publishImmutable(directory, marker, new Date(now).toISOString());
  return now;
}

/** Read the existing collection boundary without opening a new one. */
export function readTallyScope(root: string): number | null {
  const directory = join(root, '.alpacawork');
  let stored: string;
  try { stored = readImmutable(directory, marker, 24).toString('utf8'); }
  catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
    return null;
  }
  const since = Date.parse(stored);
  if (!Number.isFinite(since) || new Date(since).toISOString() !== stored)
    throw new Error(`Invalid analysis tally start time in ${join(directory, marker)}`);
  return since;
}

export const tallyUnfinished = `state NOT IN (${RUN_ENDED_STATES.map(state => `'${state}'`).join(',')})`;
const terminal = RUN_ENDED_STATES.filter(state => state !== RUN_STATE.joined).map(state => `'${state}'`).join(',');
export const tallyStartedAtMs = "round(unixepoch(json_extract(record,'$.started_at'), 'subsec') * 1000)";
const endedAtMs = "round(unixepoch(json_extract(record,'$.ended_at'), 'subsec') * 1000)";

/** Shared by collection and reads. Bind the exact collection start in milliseconds. */
const tallyLaunched = "task_id IS NOT NULL AND json_extract(record,'$.pids.agent') IS NOT NULL";
export const tallyEligible = `${tallyLaunched} AND state IN (${terminal}) AND min(${tallyStartedAtMs}, ${endedAtMs}) >= ?`;
