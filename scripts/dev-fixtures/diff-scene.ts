import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { openControlDatabase } from '@alpacawork/db';
import { taskLogSchema } from '@alpacawork/raw/task-log-schema';
import { prepareReportDiffs } from '../../apps/cli/src/report-diffs.ts';
import { fixtureAgentSetting } from '../../tests/helpers/agent-stub.ts';
import { copyWorkspace, createOriginal, profiles } from './fixture.ts';
/**
 * Development-only: reports with attached diffs, for reading the diff summary and viewer. Adds two Tasks to a fresh copy
 * of the small fixture, each waiting on a report whose diffs the CLI's own code took (prepareReportDiffs) and put in the
 * Task's diffs/ as a sent report would:
 *   T150 — one diff of this repository (in its report and its own notes), `--repo` between `--base` and `--head` (default: the commit before HEAD, and HEAD);
 *   T151 — two branches of a throwaway repository that change only documents (made and removed here);
 *   T152 — a diff that changes no file (`--head` against itself);
 *   T153 — a report naming files by absolute path: two in the project's code location (a sample git repository made
 *          beside the dummy, `<dest>-code/repo`, and one in its worktree `<dest>-code/worktree`: alpacawork's data is
 *          never read as code, so not inside it), registered for the project in config.yaml, and one in no registered
 *          place (`/tmp/…`), which stays a path to copy. Remove `<dest>-code` with the dummy.
 *   T154 — a branch of the same throwaway repository that adds a code file and a document, removes one of each and
 *          changes a third, so both sides of a split view are left empty somewhere.
 * Every report text is fictional. Nothing runs; serve the root afterwards.
 *
 *   node scripts/dev-fixtures/diff-scene.ts --dest /absolute/new/root [--repo /path/to/this/repo --base <commit> --head <commit>]
 */
const { values } = parseArgs({ options: { dest: { type: 'string' }, repo: { type: 'string' },
  base: { type: 'string' }, head: { type: 'string', default: 'HEAD' } } });
if (!values.dest) throw Error('--dest is required');
const root = values.dest, repo = resolve(values.repo ?? join(dirname(new URL(import.meta.url).pathname), '../..'));
if (spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${values.head}^{commit}`]).status !== 0)
  throw Error(`--head ${values.head} is not a commit in ${repo}`);
if (!values.base) {
  const parent = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `${values.head}~1`], { encoding: 'utf8' });
  if (parent.status !== 0) throw Error(`--base is required: ${values.head} has no parent commit in ${repo}`);
  values.base = parent.stdout.trim();
}
copyWorkspace(createOriginal({ ...profiles.small, seed: 'synthetic-v1' }).root, root);
const config = parse(readFileSync(join(root, 'config.yaml'), 'utf8'));
for (const id of ['claude'] as const) config.agents[id] = { ...fixtureAgentSetting(id), enabled: false };
config.limits = { ...config.limits, automatic_per_placement: 0 };
writeFileSync(join(root, 'config.yaml'), stringify(config));

/** A report as the CLI sends it: its git diffs taken, written to the Task's diffs/, the description with their references. */
async function attach(task: string, description: string, cwd: string): Promise<string> {
  const prepared = await prepareReportDiffs(description, cwd);
  for (const file of prepared.files) {
    const path = join(root, 'tasks', task, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.bytes);
  }
  return prepared.description;
}

const one = await attach('T150', 'This synthetic report shows the selected code revisions. ' +
  'Open the attached diff to read the changed files.\n\n```sh\n' + `git -C ${repo} diff ${values.base}..${values.head}` + '\n```\n\n' +
  'Updated screen text and tests too. Independent review passed. The changes have not been merged into main.', repo);

const none = await attach('T152', 'The review found nothing to change.\n\n```sh\n' + `git -C ${repo} diff ${values.head}..${values.head}` + '\n```', repo);

// Two branches from one base that change only documents.
const scratch = mkdtempSync(join(tmpdir(), 'alpacawork-diff-scene-'));
let two: string, three: string;
try {
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', scratch, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
      { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    if (result.status !== 0) throw Error(result.stderr);
    return result.stdout.trim();
  };
  const write = (path: string, text: string) => { mkdirSync(dirname(join(scratch, path)), { recursive: true }); writeFileSync(join(scratch, path), text); };
  const commit = (message: string) => { git('add', '.'); git('commit', '-qm', message, '--no-gpg-sign'); };
  const SKILL = (name: string) => `# ${name}\n\n` +
    'The imaginary plant catalog groups drawings by leaf color and flower shape. All catalog entries are fictional. ' +
    'The guide defines the sample reading order. Read the drawings and captions together.\n\n## Roles\n\n' +
    'The sample index groups drawings by type. Otherwise use the defaults in the table.\n';
  git('init', '-q', '-b', 'main');
  write('catalog/plants/SKILL.md', SKILL('plants'));
  write('catalog/labels/SKILL.md', SKILL('labels'));
  commit('base');
  const setup = (name: string) => `# Sample reading guide (${name})\n\n` +
    'Read when a visitor opens the fictional plant catalog.\n\n## Steps\n\n' +
    '1. Choose an imaginary plant.\n2. Read the sample caption.\n3. Compare its leaf and flower drawings.\n';
  const branch = (name: string, skill: string) => {
    git('switch', '-qc', name, 'main');
    write(`catalog/${skill}/setup.md`, setup(skill));
    write(`catalog/${skill}/SKILL.md`, SKILL(skill)
      .replace('The guide defines the sample reading order.', 'The visitor follows setup.md for the sample reading order and its drawing index. The guide defines the sample reading order.')
      .replace('use the defaults in the table.', 'use the defaults in the table and skip missing drawings.'));
    commit(name);
  };
  branch('sample/catalog-guide', 'plants');
  branch('sample/catalog-labels', 'labels');
  two = await attach('T151', 'Added reading guides for both fictional catalogs, linked from their indexes. Each branch is compared from its divergence point.\n\n```sh\n' +
    `git -C ${scratch} diff main...sample/catalog-guide\ngit -C ${scratch} diff main...sample/catalog-labels\n` + '```\n\nIndependent review passed for both branches.', scratch);
  // A branch that adds and removes whole files, code and documents, beside a file it changes (T154).
  git('switch', '-qc', 'sample/notes', 'main');
  write('src/old-notes.ts', Array.from({ length: 12 }, (_, i) => `export const note${i} = 'Old note ${i}';`).join('\n') + '\n');
  write('docs/old-guide.md', '# Old guide\n\nThis guide will be replaced by a new one.\n\n- The steps moved to setup.md.\n');
  commit('old notes');
  git('switch', '-qc', 'sample/notes-next');
  rmSync(join(scratch, 'src/old-notes.ts')); rmSync(join(scratch, 'docs/old-guide.md'));
  write('src/notes.ts', '/** Notes attached to a report. */\nexport type Note = { title: string; body: string };\n\n' +
    'export function noteLine(note: Note): string {\n  return `${note.title}: ${note.body}`;\n}\n\n' +
    'export function noteLines(notes: readonly Note[]): string[] {\n  return notes.map(noteLine);\n}\n');
  // A document as a report's reader reads one: paragraphs, a list and a table wider than its words.
  write('docs/guide.md', '# Guide\n\nHow to write notes attached to a report. Notes appear below its body. Readers scan titles, then open only the bodies that interest them. ' +
    'Make the change clear from the title alone. In the body, explain how it was checked and what remains.\n\n## Writing a note\n\n1. Write a one-line title.\n2. Describe the change in the body.\n3. Explain how it was checked.\n\n' +
    '## Note types\n\n| Type | When to write | Body contents | Example |\n|---|---|---|---|\n' +
    '| Change | A screen or behavior changes | What changed, before and after, and when users notice | Centered text at a readable width in the single-column diff panel |\n' +
    '| Check | Tests or screen checks | Steps, environment (desktop/mobile, light/dark), and result | Confirmed tables extend beyond the body on desktop and mobile in both themes |\n' +
    '| Remaining | A change is deferred | Why it was deferred and where to start next | Paragraph diffs show heading markers (existing behavior) |\n\n' +
    'Tables extend beyond the body only when needed; if that is still too narrow, only the table scrolls horizontally.\n');
  write('catalog/plants/SKILL.md', SKILL('plants').replace('use the defaults in the table.', 'use the defaults in the table and follow docs/guide.md for notes.'));
  commit('notes');
  three = await attach('T154', 'Moved note types into a new file and removed the old notes and guide.\n\n```sh\n' +
    `git -C ${scratch} diff sample/notes..sample/notes-next\n` + '```', scratch);
} finally { rmSync(scratch, { recursive: true, force: true }); }

// A sample git repository with a worktree, inside the dummy, registered as its project's code location.
const code = `${root}-code`, sample = join(code, 'repo'), worktree = join(code, 'worktree');
{
  mkdirSync(join(sample, 'src'), { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', sample, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
      { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    if (result.status !== 0) throw Error(result.stderr);
  };
  writeFileSync(join(sample, 'README.md'), '# Sample\n\nThis repository stores reading settings.\n');
  writeFileSync(join(sample, 'src', 'settings.ts'), Array.from({ length: 40 }, (_, i) => i === 0 ? '/** Reading settings. */'
    : i === 1 ? 'export const settings = {' : i === 39 ? '};' : `  item${i}: ${i}, // Description of item ${i}`).join('\n') + '\n');
  git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-qm', 'sample', '--no-gpg-sign');
  git('worktree', 'add', '-q', '-b', 't153/review', worktree);
  writeFileSync(join(worktree, 'src', 'settings.ts'), '/** Reading settings (under review). */\nexport const settings = { item2: 2 };\n');
}
const located = parse(readFileSync(join(root, 'config.yaml'), 'utf8'));
const scope = openControlDatabase(root, { busyTimeoutMs: 1000 });
const projectId = String(scope.prepare(`SELECT external_id FROM tasks WHERE kind='project' LIMIT 1`).get()!.external_id);
scope.close();
located.projects = { ...located.projects, [projectId]: { cwd: sample } };
writeFileSync(join(root, 'config.yaml'), stringify(located));
const paths = `Reviewed the reading settings. Read these three files:\n\n- [Settings source](${join(sample, 'src', 'settings.ts')})\n` +
  `- Branch under review: ${join(worktree, 'src', 'settings.ts')}\n- Description: ${join(sample, 'README.md')}\n\n` +
  `The file /tmp/alpacawork-elsewhere/notes.txt is outside registered locations, so only its path can be copied.`;

const TASKS = [{ n: 150, title: 'Inspect a sample code diff', description: one, report: 'Attached the sample code diff' },
  { n: 151, title: 'Add guides for two fictional catalogs', description: two, report: 'Review fictional catalog guide diffs' },
  { n: 152, title: 'Compare identical sample revisions', description: none, report: 'Nothing needed changing' },
  { n: 153, title: 'Read fictional catalog files', description: paths, report: 'Files for review listed' },
  { n: 154, title: 'Consolidate note types', description: three, report: 'Attached a diff with added and removed files' }];
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const db = openControlDatabase(root, { busyTimeoutMs: 1000 });
try {
  db.exec('BEGIN IMMEDIATE');
  const project = db.prepare(`SELECT id FROM tasks WHERE kind='project' LIMIT 1`).get()!.id as string;
  let logs = 0;
  const log = (n: number, ordinal: number, entry: Record<string, unknown>) => {
    const parsed = taskLogSchema.parse({ id: `diff-log-${++logs}`, title: null, description: null, fromState: null, toState: null, ...entry });
    db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,?,?)').run(parsed.id, `diff-task-${n}`, ordinal, JSON.stringify(parsed));
  };
  for (const task of TASKS) {
    db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,settings,revision,created_at,updated_at)
      VALUES(?,'task',?,?,?,?,'active','waiting',0,1,NULL,1,?,?)`).run(`diff-task-${task.n}`, task.n, project, project, task.title, at(120), at(5));
    // Its goal and notes as values (task_values), as `task update --values-file` stores them. T150's notes (About) carry
    // its diff too, as notes that name a diff do.
    for (const [field, value] of Object.entries({ goal: task.title, notes: 'This is fictional work.' + (task.n === 150 ? `\n\n${task.description}` : '') }))
      db.prepare('INSERT INTO task_values(task_id,field_id,value) VALUES(?,?,?)').run(`diff-task-${task.n}`, field, JSON.stringify(value));
    db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at) VALUES(?,?,?,?,1,1,?)`)
      .run(`diff-owner-${task.n}`, `T${task.n}`, 'fixture-agent', 'claude', at(120));
    const placed = { kind: 'placement', placementId: `diff-owner-${task.n}` };
    log(task.n, 0, { kind: 'created', at: at(120), title: 'Task created', actor: { kind: 'human' }, toState: 'todo', userRequested: true });
    log(task.n, 1, { kind: 'reported', at: at(110), title: 'Started', actor: placed, fromState: 'todo', toState: 'doing' });
    log(task.n, 2, { kind: 'reported', at: at(5), title: task.report, description: task.description, actor: placed, fromState: 'doing', toState: 'waiting' });
  }
  db.prepare('UPDATE task_sequence SET next_number=? WHERE next_number<?').run(200, 200);
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA journal_mode=DELETE');
} finally { db.close(); }
console.log(JSON.stringify({ root, rows: { repository: 'T150', branches: 'T151', unchanged: 'T152', codePaths: 'T153', addedRemoved: 'T154' }, code }));
