/**
 * What a Run ran under (contract runConditionsSchema), observed once by its manager just before the agent starts and
 * kept in the Run's folder. It is a record beside the Run: a Run starts the same whether or not it could be written.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { RUN_FILES, runConditionsSchema, runFolder, runNumber, type RunConditionChange, type RunConditions, type RunConditionsView, type RunRecord } from '@alpacawork/contract/run';
import type { RunId } from '@alpacawork/contract/fields';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { readPackageVersion } from '@alpacawork/core/package-version';
import { optionalRunFile, readRunFile, writeRunFile } from './files.js';
import { personalSkillsFolder } from '../installation/agent-skill-links.js';

/** A file up to this size is digested by its bytes; a larger one (a video, an archive) by its size and time. */
const WHOLE_FILE = 256 * 1024;
/** A skill of more files than this is too large to digest at every start: its digest is null. */
const SKILL_FILES = 2000;

/** One skill folder's files, by path, bytes (or size and time) as above; null past SKILL_FILES or when unreadable. */
export function skillDigest(folder: string): string | null {
  const hash = createHash('sha256'), files: string[] = [];
  const walk = (dir: string): boolean => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = statSync(path);
      if (stat.isDirectory()) { if (!walk(path)) return false; continue; }
      if (!stat.isFile()) continue;
      if (files.push(path) > SKILL_FILES) return false;
      hash.update(relative(folder, path)).update('\0');
      hash.update(stat.size <= WHOLE_FILE ? readFileSync(path) : `${stat.size}:${stat.mtimeMs}`).update('\0');
    }
    return true;
  };
  try { return walk(folder) ? hash.digest('hex').slice(0, 16) : null; } catch { return null; }
}

function commitAt(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch { return null; }
}

/** What an agent of `adapter` working in `cwd` runs under now. */
export function observeConditions(input: { adapter: string; cwd: string; version: string; release: string | null; home?: string }): RunConditions {
  const folders = [personalSkillsFolder(input.adapter, input.home ?? homedir()), join(input.cwd, '.claude/skills'), join(input.cwd, '.agents/skills')];
  const skills = [...new Set(folders)].flatMap(folder => {
    let names: string[];
    try { names = readdirSync(folder).filter(name => !name.startsWith('.') && statSync(join(folder, name)).isDirectory()).sort(); }
    catch { return []; }
    return [{ folder, items: names.map(name => ({ name, digest: skillDigest(join(folder, name)) })) }];
  });
  let source: string | null = null;
  try { source = input.release ? String(readPackageVersion(input.release).source ?? '') || null : null; } catch { source = null; }
  return { v: 1, observedAt: new Date().toISOString(), version: input.version, release: input.release, source,
    cwd: { path: input.cwd, commit: commitAt(input.cwd) },
    skills };
}

/** Keeps what the Run ran under in its folder, once: a manager started again for the same Run leaves the first. */
export function recordConditions(runFolder: string, observe: () => RunConditions): void {
  try {
    if (lstatSync(join(runFolder, RUN_FILES.conditions), { throwIfNoEntry: false })) return;
    writeRunFile(runFolder, RUN_FILES.conditions, JSON.stringify(observe()));
  } catch (error) { console.error('Run conditions could not be kept', error); }
}

/** What a Run ran under, or null when it has no record of it (a Run from before they were kept). */
export function readConditions(runFolder: string): RunConditions | null {
  const bytes = optionalRunFile(() => readRunFile(runFolder, RUN_FILES.conditions, 1024 * 1024));
  if (!bytes) return null;
  try { const parsed = runConditionsSchema.safeParse(JSON.parse(bytes.toString('utf8'))); return parsed.success ? parsed.data : null; }
  catch { return null; }
}

/** How far back the Run before one is looked for: Runs kept no conditions before they were recorded. */
const EARLIER_LOOKBACK = 500;

/** What changed in alpacawork and the skills from one Run's conditions to a later one's. */
export function conditionChanges(before: RunConditions, after: RunConditions): RunConditionChange[] {
  const changes: RunConditionChange[] = [];
  const release = (c: RunConditions) => `${c.version}${c.source ? ` (${c.source})` : ''}`;
  if (release(before) !== release(after)) changes.push({ kind: 'release', name: null, before: release(before), after: release(after) });
  const named = (c: RunConditions) => new Map(c.skills.flatMap(({ folder, items }) => items.map(item => [`${folder}/${item.name}`, item.digest] as const)));
  const earlier = named(before), later = named(after);
  for (const name of [...new Set([...earlier.keys(), ...later.keys()])].sort()) {
    const was = earlier.get(name) ?? null, now = later.get(name) ?? null;
    if (was !== now || earlier.has(name) !== later.has(name)) changes.push({ kind: 'skill', name, before: was, after: now });
  }
  return changes;
}

/** What changed in the launch from one Run of a placement to its next: the model, the effort, the command. */
export function launchChanges(before: Pick<RunRecord, 'launch'>, after: Pick<RunRecord, 'launch'>): RunConditionChange[] {
  const value = (record: Pick<RunRecord, 'launch'>, key: string) => {
    const chosen = (record.launch.values as Record<string, unknown>)[key];
    return typeof chosen === 'string' ? chosen : null;
  };
  const changes: RunConditionChange[] = [];
  for (const kind of ['model', 'effort'] as const)
    if (value(before, kind) !== value(after, kind)) changes.push({ kind, name: null, before: value(before, kind), after: value(after, kind) });
  const command = (record: Pick<RunRecord, 'launch'>) => `${record.launch.adapter} ${record.launch.argv.join(' ')}`;
  if (command(before) !== command(after)) changes.push({ kind: 'command', name: null, before: command(before), after: command(after) });
  return changes;
}

/** run conditions: what Task Run `run` ran under and what changed before it, compared with Runs `readable` allows. */
export function readConditionsView(root: string, run: RunId, readable: (run: RunId) => boolean): RunConditionsView {
  const store = RunStore.openReadable(root, { busyTimeoutMs: 0 });
  let record: RunRecord | null = null, placementRuns: RunRecord[] = [];
  try {
    record = store?.get(run) ?? null;
    if (record) placementRuns = store!.conversationRuns(record.placementId);
  } finally { store?.close(); }
  if (!record) throw new Problem(PROBLEM_CODE.notFound, 'Run does not exist', { run }, { reason: { kind: 'run_does_not_exist' } });
  const conditions = readConditions(runFolder(root, run));
  let sinceEarlier: RunConditionsView['sinceEarlier'] = null;
  if (conditions) for (let n = runNumber(run) - 1; n > 0 && n >= runNumber(run) - EARLIER_LOOKBACK; n--) {
    const earlier = readConditions(runFolder(root, `R${n}` as RunId));
    if (earlier && readable(`R${n}` as RunId)) { sinceEarlier = { run: `R${n}` as RunId, changes: conditionChanges(earlier, conditions) }; break; }
  }
  const previous = placementRuns.filter(each => runNumber(each.id) < runNumber(run)).at(-1);
  const chosen = (key: string) => { const value = (record!.launch.values as Record<string, unknown>)[key]; return typeof value === 'string' ? value : null; };
  return { run, launch: { agent: record.agent, model: chosen('model'), effort: chosen('effort') }, conditions, sinceEarlier,
    sincePlacement: previous ? { run: previous.id, changes: launchChanges(previous, record) } : null };
}
