import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { fixtureAgentSetting, inertFixtureLaunch } from '../../tests/helpers/agent-stub.ts';
/**
 * Development-only: one synthetic scene for reading the home list's time strips. Adds rows to a fresh copy of the small
 * fixture, every time relative to now, so they fall inside the list's first day: a row working with children, grandchild and
 * member running, and one row each for your review, your question, a stop, a finish and a hold, each with many ordinary
 * records behind it. Every text is fictional. The Runs that go are held by this process, which ends by itself.
 *
 *   node scripts/dev-fixtures/list-scene.ts --dest /absolute/new/root --hold-seconds 1800   then serve that root while it holds.
 */
import { closeSync, constants, openSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { tryLock, unlock } from '@alpacawork/core';
import { openControlDatabase, taskHash } from '@alpacawork/db';
import { RUN_FILES } from '@alpacawork/contract/run';
import { taskLogSchema } from '@alpacawork/raw/task-log-schema';
import { RunStore } from '@alpacawork/runs';
import { record } from '../../tests/runs-fixtures.ts';
import { copyWorkspace, createOriginal, profiles } from './fixture.ts';

const { values } = parseArgs({ options: { dest: { type: 'string' }, 'hold-seconds': { type: 'string', default: '1800' } } });
if (!values.dest) throw Error('--dest is required');
const root = values.dest;
copyWorkspace(createOriginal({ ...profiles.small, seed: 'synthetic-v1' }).root, root);
const config = parse(readFileSync(join(root, 'config.yaml'), 'utf8'));
for (const id of ['claude'] as const) config.agents[id] = { ...fixtureAgentSetting(id), enabled: false };
config.limits = { ...config.limits, automatic_per_placement: 0 };
writeFileSync(join(root, 'config.yaml'), stringify(config));

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const internal = (n: number) => `list-task-${n}`;
const owner = (n: number) => `list-owner-${n}`;
const TASKS: { n: number; parent?: number; title: string; state: string; hold?: boolean; since: number }[] = [
  { n: 120, title: 'Ship the payment changes together', state: 'doing', since: 420 },
  { n: 121, parent: 120, title: 'Migrate billing', state: 'doing', since: 400 },
  { n: 122, parent: 120, title: 'Migrate refunds', state: 'doing', since: 380 },
  { n: 123, parent: 121, title: 'Add billing tests', state: 'doing', since: 300 },
  { n: 124, parent: 120, title: 'Write the migration guide', state: 'done', since: 360 },
  { n: 125, parent: 120, title: 'Inventory the old payment system', state: 'done', since: 400 },
  { n: 126, parent: 125, title: 'Count calls to the old payment system', state: 'done', since: 380 },
  { n: 130, title: 'Review search filters', state: 'waiting', since: 500 },
  { n: 131, parent: 130, title: 'Study filter usage', state: 'done', since: 480 },
  { n: 132, title: 'Choose invoice wording', state: 'doing', since: 300 },
  { n: 133, title: 'Move log storage', state: 'error', since: 260 },
  { n: 134, title: 'Simplify notification settings', state: 'done', since: 600 },
  { n: 135, title: 'Remove the old screen', state: 'doing', hold: true, since: 700 },
];
const running: string[] = [];
const db = openControlDatabase(root, { busyTimeoutMs: 1000 });
try {
  db.exec('BEGIN IMMEDIATE');
  const project = db.prepare(`SELECT id FROM tasks WHERE kind='project' LIMIT 1`).get()!.id as string;
  const insertRequest = db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state,wait_cycle_id)
    VALUES(?,?,?,1,?,'new',?,'instruction',?,?,'queued',NULL)`);
  const insertRun = db.prepare(`INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,?,?,?)`);
  const insertLog = db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,?,?)');
  const ordinal = new Map<number, number>();
  let logs = 0, runNumber = 2000, requests = 0;
  const log = (n: number, entry: Record<string, unknown>) => {
    const parsed = taskLogSchema.parse({ id: `list-log-${++logs}`, title: null, description: null, fromState: null, toState: null, ...entry });
    insertLog.run(parsed.id, internal(n), ordinal.get(n) ?? 0, JSON.stringify(parsed));
    ordinal.set(n, (ordinal.get(n) ?? 0) + 1);
    return parsed.id;
  };
  const placed = (n: number) => ({ kind: 'placement', placementId: owner(n) });
  db.prepare('INSERT INTO agents(id,created_at) VALUES(?,?)').run('list-agent-member', ago(800));
  for (const task of TASKS) {
    db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,settings,revision,created_at,updated_at)
      VALUES(?,'task',?,?,?,?,'active',?,?,?,NULL,1,?,?)`).run(internal(task.n), task.n, task.parent ? internal(task.parent) : project, project, task.title,
      task.state, task.hold ? 1 : 0, task.parent ? 0 : 1, ago(task.since), ago(task.since));
    // Its goal and notes as values (task_values), as `task update --values-file` stores them.
    for (const [field, value] of Object.entries({ goal: task.title, notes: 'This is fictional work.' }))
      db.prepare('INSERT INTO task_values(task_id,field_id,value) VALUES(?,?,?)').run(internal(task.n), field, JSON.stringify(value));
    db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at) VALUES(?,?,?,?,1,1,?)`).run(owner(task.n), `T${task.n}`, 'fixture-agent', 'claude', ago(task.since));
    log(task.n, { kind: 'created', at: ago(task.since), title: 'Task created', actor: task.parent ? placed(task.parent) : { kind: 'human' }, toState: 'todo', userRequested: !task.parent });
  }
  /** A Run on Task `n` from `from` minutes ago: ended `to` minutes ago, or still going when `to` is null. */
  const work = (n: number, from: number, to: number | null, state: 'succeeded' | 'failed' = 'succeeded', placement = owner(n), reports = true) => {
    const id = `R${++runNumber}`, request = `list-request-${++requests}`, member = placement !== owner(n);
    insertRequest.run(request, `T${n}`, placement, taskHash(internal(n), 1), 'This is a fictional request.', JSON.stringify({ kind: 'human' }), ago(from));
    insertRun.run(runNumber, JSON.stringify(record(id, { task: `T${n}`, placementId: placement, requestId: request, agent: 'claude', role: member ? 'worker' : 'owner', cwd: root,
      state: to === null ? 'running' : state, reason: state === 'failed' ? 'exit' : null, created_at: ago(from), started_at: ago(from), ended_at: to === null ? null : ago(to),
      ...(to === null ? { pids: { manager: 1, agent: 2 } } : { exit: { code: state === 'failed' ? 1 : 0, signal: null } }),
      launch: inertFixtureLaunch('codex') })), 'This is a fictional request.', to === null ? null : 'This is a fictional result.', to === null ? 'pending' : 'present');
    if (to === null) running.push(id);
    // A Run that ends without a report would stop its Task.
    else if (state === 'succeeded' && !member && reports) log(n, { kind: 'reported', at: ago(to), title: 'Milestone report', description: 'This is a fictional report.', actor: placed(n), fromState: 'doing', toState: 'doing', runId: id });
    return id;
  };
  /** What agents write as they go: each a record History reads and the list does not mark. */
  const notes = (n: number, ...minutes: number[]) => minutes.forEach((at, index) =>
    log(n, { kind: 'reported', at: ago(at), title: index % 2 ? `Progress note ${index + 1}` : `Progress update ${index + 1}`, description: 'This is a fictional note.', actor: placed(n), ...(index % 2 ? {} : { fromState: 'doing', toState: 'doing' }) }));

  // Working: its own Runs, a member, children and a grandchild, five going now.
  log(120, { kind: 'reported', at: ago(415), title: 'Plan prepared', actor: placed(120), fromState: 'todo', toState: 'doing' });
  notes(120, 400, 350, 300, 260, 200, 150, 90, 45, 12);
  work(120, 410, 380); work(120, 300, 270); work(120, 120, 100); work(120, 25, null);
  db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at) VALUES(?,?,?,?,0,1,?)`).run('list-member-120', 'T120', 'list-agent-member', 'claude', ago(200));
  work(120, 180, 150, 'succeeded', 'list-member-120'); work(120, 10, null, 'succeeded', 'list-member-120');
  for (const [n, from] of [[121, 40], [122, 30], [123, 15]] as const) {
    log(n, { kind: 'reported', at: ago(from + 1), title: 'Started', actor: placed(n), fromState: 'todo', toState: 'doing' });
    work(n, from, null);
  }
  // Children that finished, one with its own child: the row's past counts them too.
  for (const [n, from, to] of [[124, 355, 300], [125, 395, 330], [126, 375, 340]] as const) {
    log(n, { kind: 'reported', at: ago(from + 1), title: 'Started', actor: placed(n), fromState: 'todo', toState: 'doing' });
    work(n, from, to);
    log(n, { kind: 'reported', at: ago(to - 1), title: 'Finished', description: 'This is a fictional report.', actor: placed(n), fromState: 'doing', toState: 'done' });
  }

  // Your review: before it, what it asked, what you answered, and a review you sent back.
  log(130, { kind: 'reported', at: ago(495), title: 'Started', actor: placed(130), fromState: 'todo', toState: 'doing' });
  notes(130, 470, 420, 380); work(130, 490, 440); work(130, 400, 330); work(130, 200, 148, 'succeeded', owner(130), false);
  log(131, { kind: 'reported', at: ago(409), title: 'Investigation complete', description: 'This is a fictional report.', actor: placed(131), fromState: 'doing', toState: 'done' });
  work(131, 475, 410);
  log(130, { kind: 'reported', at: ago(320), title: 'Ready for review', description: 'This is a fictional report.', actor: placed(130), fromState: 'doing', toState: 'waiting' });
  log(130, { kind: 'reported', at: ago(205), title: 'Revising', actor: placed(130), fromState: 'waiting', toState: 'doing' });
  log(130, { kind: 'reported', at: ago(150), title: 'Revised and ready for review', description: 'This is a fictional report.', actor: placed(130), fromState: 'doing', toState: 'waiting' });

  // Your question.
  log(132, { kind: 'reported', at: ago(295), title: 'Started', actor: placed(132), fromState: 'todo', toState: 'doing' });
  notes(132, 270, 230, 190); work(132, 290, 160);
  log(132, { kind: 'asked', at: ago(160), title: 'Which wording should we use', description: 'Choose the wording.', actor: placed(132), askedTo: null,
    decide: [{ decide_kind: 'choose', decide_question: 'Choose wording', decide_choices: [{ decide_choice: 'Short', decide_choice_detail: 'This is a fictional option.' }, { decide_choice: 'Long', decide_choice_detail: 'This is a fictional option.' }] }] });

  // A stop: its Run failed, and that put the Task into error.
  log(133, { kind: 'reported', at: ago(255), title: 'Started', actor: placed(133), fromState: 'todo', toState: 'doing' });
  notes(133, 240, 190, 140);
  work(133, 250, 180);
  const failed = work(133, 150, 95, 'failed');
  log(133, { kind: 'linked', at: ago(95), actor: { kind: 'human' }, fromState: 'doing', toState: 'error', runId: failed });

  // A finish, reported by its owner.
  log(134, { kind: 'reported', at: ago(595), title: 'Started', actor: placed(134), fromState: 'todo', toState: 'doing' });
  notes(134, 560, 500, 450, 400); work(134, 590, 520); work(134, 480, 360);
  log(134, { kind: 'reported', at: ago(359), title: 'Cleanup complete', description: 'This is a fictional report.', actor: placed(134), fromState: 'doing', toState: 'done' });

  // A hold you set.
  log(135, { kind: 'reported', at: ago(695), title: 'Started', actor: placed(135), fromState: 'todo', toState: 'doing' });
  notes(135, 650, 610); work(135, 690, 600);
  log(135, { kind: 'reported', at: ago(590), title: 'Put on hold', actor: { kind: 'human' }, fromState: 'doing', toState: 'held' });

  db.prepare('UPDATE task_sequence SET next_number=?').run(200);
  db.prepare('UPDATE run_sequence SET next_number=?').run(runNumber + 1);
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA journal_mode=DELETE');
} finally { db.close(); }

// A Run goes while its manager lock is held.
const store = new RunStore(root, { busyTimeoutMs: 1000 });
const held = running.map(id => {
  store.prepareFolder(id);
  const fd = openSync(join(store.folder(id), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
  if (!tryLock(fd)) throw Error(`Manager lock of ${id} is taken`);
  return fd;
});
// Serve is this workspace's one writer.
store.close();
console.log(JSON.stringify({ root, rows: { working: 'T120', review: 'T130', question: 'T132', stop: 'T133', finish: 'T134', hold: 'T135' }, running }));
setTimeout(() => { for (const fd of held) { unlock(fd); closeSync(fd); } process.exit(0); }, Number(values['hold-seconds']) * 1000);
