import { isAbsolute, resolve } from 'node:path';
import { RUN_SUMMARY_LIMITS as limits, type RunOutputSummary, type RunProduced, type RunSummary, type RunTest } from '@alpacawork/contract/run-summary';
import { inlineLinks } from '@alpacawork/contract/report-media';
import { type RunStepEntry, type StepFingerprint } from '@alpacawork/contract/run';
import { object } from '../agents/adapters/output.js';
import { stepEventFingerprint } from './step-journal.js';
import { evidenceDigest, rawInputDigest, isTestCommand, shellDirectory, shellInput, shellProduction, type ShellProduction } from './shell-evidence.js';
import type { ActivityEvent } from './activity-events.js';

import { prLinks } from '../references.js';

const pullRequestUrls = (text: string) => [...prLinks([text])];
const editTools = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const bounded = (ref: string) => ref.length > 0 && ref.length <= 300 && !/[\x00-\x1f]/.test(ref);

type Evidence = {
  input?: { digest?: string; fingerprint: StepFingerprint };
  test?: { digest: string; dir: string | null };
  production?: { actions: ReadonlySet<ShellProduction>; dir: string | null; prs: string[] };
  writes?: string[];
  chars?: number;
  produced?: Omit<RunProduced, 'files'>;
};

/** References are detected on completed writes, with no content from the files kept. */
function fileWrites(event: ActivityEvent, cwd: string): string[] | undefined {
  if (event.dropped || !event.call) return;
  const { tool, input } = event.call;
  const data = object(input);
  const paths = tool === 'codex:file_change' && Array.isArray(data.changes)
    ? data.changes.slice(-limits.files).map(change => object(change).path)
    : editTools.has(tool) ? [data.file_path ?? data.notebook_path] : [];
  const files = [...new Set(paths.flatMap(path => typeof path === 'string' && bounded(path)
    ? [resolve(cwd, path)].filter(bounded) : []))];
  return files.length ? files : undefined;
}

export function stepEvidence(evidence: Evidence | undefined, event: ActivityEvent, step: number, cwd: string, readTests: boolean): Evidence | undefined {
  const shell = event.dropped ? undefined : shellInput(event.call, String(event.stepTool ?? event.toolName), event.input);
  const script = shell?.script;
  const known = evidence ?? {};
  if (shell && readTests && !known.input) {
    const fingerprint = stepEventFingerprint(event, script);
    const digest = rawInputDigest(event, cwd);
    if (fingerprint) known.input = { fingerprint, ...(digest && { digest }) };
  }
  if (shell && script) {
    const test = readTests && !known.test && isTestCommand(script);
    const actions = known.production ? null : shellProduction(script);
    if (test || actions?.size) {
      const dir = shellDirectory(cwd, shell)?.dir ?? null;
      if (test) known.test = { digest: evidenceDigest(script), dir };
      if (actions?.size) known.production = { actions, dir, prs: actions.has('merged') ? pullRequestUrls(script) : [] };
    }
  }
  const writes = fileWrites(event, cwd);
  if (writes) known.writes = writes;

  const outcome = event.outcome;
  if (event.kind === 'tool_end' && outcome) {
    const output = outcome.output, text = output?.text ?? outcome.result.text;
    known.chars = output ? output.text.length + output.omitted : text.length;
    if (!outcome.failed && !outcome.unknown) {
      const production = known.production;
      if (production) known.produced = producedBy(production, text, step);
    } else {
      delete known.produced;
      delete known.writes;
    }
  }
  return Object.keys(known).length ? known : undefined;
}

function producedBy(production: NonNullable<Evidence['production']>, text: string, step: number) {
  const { actions } = production;
  const commits = actions.has('commit')
    ? [...text.matchAll(/^\[(detached HEAD|[^\]\n ]+) (?:\(root-commit\) )?([a-f0-9]{7,64})\]/gm)].slice(0, limits.commits)
      .map(([, branch, sha]) => ({ step, branch: branch === 'detached HEAD' || !bounded(branch!) ? null : branch!, sha: sha! }))
    : [];
  const lines = text.split('\n').map(line => line.trim());
  const mergeLines = lines.filter(line => /\b(?:merged pull request|successfully merged)\b/i.test(line));
  const repos = mergeLines.flatMap(line => [...line.matchAll(/\b([\w-]+)\/([\w.-]+)#([1-9]\d*)\b/g)]
    .map(([, owner, repo, number]) => `https://github.com/${owner}/${repo}/pull/${number}`));
  const merged = actions.has('merged') && mergeLines.length
    ? [...prLinks([...mergeLines, ...repos, ...(production.prs.length === 1 ? production.prs : [])])] : [];
  // In a combined shell step the create command's stand-alone URL is distinct from the merge notice.
  const created = actions.has('created') ? [...prLinks(lines.filter(line => /^https:\/\/github\.com\/[^\s]+$/i.test(line)))] : [];
  const prs = [...created.map(url => ({ step, url, action: 'created' as const })),
    ...merged.map(url => ({ step, url, action: 'merged' as const }))].filter(item => bounded(item.url)).slice(0, limits.prs);
  return { commits, prs };
}

export type ObservedStep = { entry: RunStepEntry; evidence?: Evidence; completed: boolean };
export const noProduced = (): RunProduced => ({ commits: [], prs: [], files: [] });
export const noOutputs = (): RunOutputSummary => ({ chars: 0, largest: [] });
export function stepTotals(steps: Iterable<ObservedStep>) {
  const outputs = noOutputs(), produced = noProduced(), files = new Map<string, number>();
  let truncated = false;
  const keep = <T>(target: T[], values: readonly T[], max: number) => {
    const available = max - target.length;
    if (values.length > available) truncated = true;
    target.push(...values.slice(0, available));
  };
  for (const { entry, evidence, completed } of steps) {
    const chars = entry.output?.chars ?? evidence?.chars ?? 0;
    outputs.chars += chars;
    if (chars > 0) {
      outputs.largest.push({ step: entry.n, chars });
      outputs.largest.sort((a, b) => b.chars - a.chars || a.step - b.step);
      if (outputs.largest.length > limits.largest) outputs.largest.pop();
    }
    if (completed && entry.state === 'done') {
      keep(produced.commits, evidence?.produced?.commits ?? [], limits.commits);
      keep(produced.prs, evidence?.produced?.prs ?? [], limits.prs);
      for (const path of evidence?.writes ?? []) {
        files.delete(path);
        files.set(path, entry.n);
        if (files.size > limits.files) files.delete(files.keys().next().value!);
      }
    }
  }
  produced.files = [...files].map(([path, step]) => ({ path, step }));
  return { outputs, produced, truncated };
}

export type TestObservation = { test: RunTest; digest: string; at: number | null };
/** Classify on the read of the step index; the journal stores a checkout for all shell steps. */
export function testObservations(steps: Iterable<ObservedStep>): TestObservation[] {
  const commits = new Map<string, string>(), tests: TestObservation[] = [];
  for (const { entry, evidence, completed } of steps) {
    const candidate = evidence?.test;
    if (candidate && tests.length < limits.tests) {
      const head = entry.head;
      const inferred = head === undefined && candidate.dir ? commits.get(candidate.dir) : undefined;
      tests.push({ test: { step: entry.n, line: entry.fingerprint?.line ?? entry.text,
        state: completed ? entry.state === 'done' || entry.state === 'failed' ? entry.state : 'unknown' : 'unknown',
        commit: head?.commit ?? inferred ?? null, dirty: head?.dirty ?? null,
        ...(head && { dir: head.dir, dirSource: head.dirSource }), ...(head?.diffDigest && { diffDigest: head.diffDigest }),
        commitSource: head ? 'observed' : inferred ? 'inferred' : null },
      digest: candidate.digest, at: entry.startedAt ? Date.parse(entry.startedAt) : null });
    }
    const commit = evidence?.produced?.commits.at(-1);
    if (completed && entry.state === 'done' && evidence?.production?.dir && commit) commits.set(evidence.production.dir, commit.sha);
  }
  return tests;
}

export function stepRepeats(steps: Iterable<ObservedStep>): RunSummary['repeats'] {
  type Group = RunSummary['repeats']['exact'][number] & { output?: string };
  const exact = new Map<string, Group>(), approximate = new Map<string, Group>();
  for (const { entry, evidence } of steps) {
    const fingerprint = evidence?.input?.fingerprint ?? entry.fingerprint;
    const rawDigest = entry.rawDigest ?? evidence?.input?.digest;
    const { output } = entry;
    if (entry.kind !== 'command' || !fingerprint) continue;
    const add = (groups: Map<string, Group>, key: string, exactDigest?: string) => {
      const digest = output?.whole ? output.digest : undefined;
      const group = groups.get(key) ?? { fingerprint, ...(exactDigest && { rawDigest: exactDigest }),
        count: 0, steps: [], sameOutput: digest !== undefined, output: digest };
      if (group.steps.length < limits.repeats) group.steps.push(entry.n);
      group.count++;
      group.sameOutput &&= digest !== undefined && digest === group.output;
      groups.set(key, group);
    };
    if (rawDigest) add(exact, rawDigest, rawDigest);
    add(approximate, JSON.stringify(fingerprint));
  }
  const top = (groups: Map<string, Group>) => [...groups.values()].filter(group => group.count > 1)
    .sort((a, b) => b.count - a.count || a.steps[0]! - b.steps[0]!).slice(0, limits.repeats)
    .map(({ output: _output, ...group }) => group);
  return { exact: top(exact), approximate: top(approximate) };
}

export function memberBasis(tail: string): string[] {
  const line = tail.trimEnd().split(/\r?\n/).at(-1)?.trimStart();
  if (!line?.startsWith('Based on:')) return [];
  const refs = line.slice('Based on:'.length).split(';').map(value => {
    const ref = value.trim();
    const link = inlineLinks(ref).find(item => !item.image && item.at === 0);
    return link?.href.trim() ?? ref;
  });
  const valid = (ref: string) => bounded(ref) && (isAbsolute(ref) || /^R\d+$/.test(ref) ||
    /^(?:\.\.?\/|~\/|[\p{L}\p{N}_.-]+\/|https?:\/\/\S+$)/u.test(ref) || /^[^\/<>:]+\.[\p{L}\p{N}]+$/u.test(ref));
  return [...new Set(refs.filter(valid))].slice(0, limits.basis);
}
