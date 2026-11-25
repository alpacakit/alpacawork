/**
 * What a Run ran under (contract runConditionsSchema), observed once by its manager just before the agent starts and
 * kept in the Run's folder. It is a record beside the Run: a Run starts the same whether or not it could be written.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { RUN_FILES, runConditionsSchema, runFolder, type RunConditions, type RunConditionsView, type RunRecord } from '@alpacawork/contract/run';
import type { RunId } from '@alpacawork/contract/fields';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { readPackageVersion } from '@alpacawork/core/package-version';
import { optionalRunFile, readRunFile, writeRunFile } from './files.js';
import { personalSkillsFolder } from '../installation/agent-skill-links.js';

/**
 * The person's own instruction files an agent reads at every start, relative to HOME: they steer it as skills do, and
 * no commit holds them. A work folder's own instruction files are in its commit.
 */
const PERSONAL_INSTRUCTIONS = ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.agents/AGENTS.md'];
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
  const home = input.home ?? homedir(), personal = personalSkillsFolder(input.adapter, home);
  const folders = [[personal, 'personal'], [join(input.cwd, '.claude/skills'), 'project'], [join(input.cwd, '.agents/skills'), 'project']] as const;
  const seen = new Set<string>();
  const skills = folders.flatMap(([folder, scope]) => {
    if (seen.has(folder)) return [];
    seen.add(folder);
    let names: string[];
    try { names = readdirSync(folder).filter(name => !name.startsWith('.') && statSync(join(folder, name)).isDirectory()).sort(); }
    catch { return []; }
    return [{ scope, folder, items: names.map(name => ({ name, digest: skillDigest(join(folder, name)) })) }];
  });
  let source: string | null = null;
  try { source = input.release ? String(readPackageVersion(input.release).source ?? '') || null : null; } catch { source = null; }
  return { v: 1, observedAt: new Date().toISOString(), version: input.version, release: input.release, source,
    cwd: { path: input.cwd, commit: commitAt(input.cwd) },
    skills, instructions: PERSONAL_INSTRUCTIONS.flatMap(path => {
      const file = join(home, path);
      try { return [{ path: file, digest: createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16) }]; }
      catch { return []; }
    }) };
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

/** run conditions: how Task Run `run` was launched and what it ran under, as recorded; comparing Runs is the analysis's. */
export function readConditionsView(root: string, run: RunId): RunConditionsView {
  const store = RunStore.openReadable(root, { busyTimeoutMs: 0 });
  let record: RunRecord | null = null;
  try { record = store?.get(run) ?? null; } finally { store?.close(); }
  if (!record) throw new Problem(PROBLEM_CODE.notFound, 'Run does not exist', { run }, { reason: { kind: 'run_does_not_exist' } });
  const chosen = (key: string) => { const value = (record!.launch.values as Record<string, unknown>)[key]; return typeof value === 'string' ? value : null; };
  return { run, launch: { agent: record.agent, model: chosen('model'), effort: chosen('effort') }, conditions: readConditions(runFolder(root, run)) };
}
