import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { fixtureAgentSetting, inertFixtureLaunch } from '../../tests/helpers/agent-stub.ts';
/**
 * Development-only: parents with work going on below for the reader's working row — one child only (T140), the
 * parent and three Tasks below with a grandchild and a child with two people (T150), nobody running (T160), the
 * parent only (T170), and a child running while its parent awaits your answer (T180, so the child is a row of its own). Every time is relative to now and every text is fictional. The Runs that go are held by this
 * process, which ends by itself, as list-scene's are.
 *
 *   node scripts/dev-fixtures/child-working-scene.ts --dest /absolute/new/root --hold-seconds 1800   then serve that root while it holds.
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
const internal = (n: number) => `child-task-${n}`;
const owner = (n: number) => `child-owner-${n}`;
const TASKS: { n: number; parent?: number; title: string; state: string; hold?: boolean; since: number }[] = [
  { n: 140, title: 'Ship the payment changes together', state: 'doing', since: 300 },
  { n: 141, parent: 140, title: 'Fix amounts shown on the billing screen', state: 'doing', since: 60 },
  { n: 142, parent: 140, title: 'Write the migration guide', state: 'done', since: 280 },
  { n: 150, title: 'Review search filters', state: 'doing', since: 400 },
  { n: 151, parent: 150, title: 'Study filter usage, list common combinations and unused conditions, and recommend which conditions to keep', state: 'doing', since: 50 },
  { n: 152, parent: 150, title: 'Choose the default sort order', state: 'doing', since: 40 },
  { n: 153, parent: 150, title: 'Add search API tests', state: 'doing', since: 200 },
  { n: 154, parent: 153, title: 'Test date range filters', state: 'doing', since: 20 },
  { n: 155, parent: 150, title: 'Remove the old filter screen', state: 'done', since: 380 },
  { n: 160, title: 'Move log storage', state: 'doing', since: 500 },
  { n: 170, title: 'Align notification wording', state: 'doing', since: 120 },
  { n: 171, parent: 170, title: 'Collect the current wording', state: 'done', since: 110 },
  { n: 161, parent: 160, title: 'Compare storage destinations', state: 'done', since: 480 },
  { n: 162, parent: 160, title: 'Write the migration steps', state: 'doing', since: 200 },
  { n: 180, title: 'Redesign the onboarding emails', state: 'doing', since: 240 },
  { n: 181, parent: 180, title: 'Draft the welcome email', state: 'doing', since: 70 },
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
    const parsed = taskLogSchema.parse({ id: `child-log-${++logs}`, title: null, description: null, fromState: null, toState: null, ...entry });
    insertLog.run(parsed.id, internal(n), ordinal.get(n) ?? 0, JSON.stringify(parsed));
    ordinal.set(n, (ordinal.get(n) ?? 0) + 1);
    return parsed.id;
  };
  const placed = (n: number) => ({ kind: 'placement', placementId: owner(n) });
  db.prepare('INSERT INTO agents(id,created_at) VALUES(?,?)').run('child-agent-member', ago(800));
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
  const work = (n: number, from: number, to: number | null, state: 'succeeded' | 'failed' = 'succeeded', placement = owner(n), reports = true, values: Record<string, string> = { model: 'opus', effort: 'high' }) => {
    const id = `R${++runNumber}`, request = `child-request-${++requests}`, member = placement !== owner(n);
    insertRequest.run(request, `T${n}`, placement, taskHash(internal(n), 1), 'This is a fictional request.', JSON.stringify({ kind: 'human' }), ago(from));
    insertRun.run(runNumber, JSON.stringify(record(id, { task: `T${n}`, placementId: placement, requestId: request, agent: 'claude', role: member ? 'worker' : 'owner', cwd: root,
      state: to === null ? 'running' : state, reason: state === 'failed' ? 'exit' : null, created_at: ago(from), started_at: ago(from), ended_at: to === null ? null : ago(to),
      ...(to === null ? { pids: { manager: 1, agent: 2 } } : { exit: { code: state === 'failed' ? 1 : 0, signal: null } }),
      launch: inertFixtureLaunch('claude', values) })), 'This is a fictional request.', to === null ? null : 'This is a fictional result.', to === null ? 'pending' : 'present');
    if (to === null) running.push(id);
    // A Run that ends without a report would stop its Task.
    else if (state === 'succeeded' && !member && reports) log(n, { kind: 'reported', at: ago(to), title: 'Milestone report', description: 'This is a fictional report.', actor: placed(n), fromState: 'doing', toState: 'doing', runId: id });
    return id;
  };
  /** What agents write as they go: each a record History reads and the list does not mark. */
  const notes = (n: number, ...minutes: number[]) => minutes.forEach((at, index) =>
    log(n, { kind: 'reported', at: ago(at), title: index % 2 ? `Progress note ${index + 1}` : `Progress update ${index + 1}`, description: 'This is a fictional note.', actor: placed(n), ...(index % 2 ? {} : { fromState: 'doing', toState: 'doing' }) }));

  const start = (n: number, from: number) => log(n, { kind: 'reported', at: ago(from + 1), title: 'Started', actor: placed(n), fromState: 'todo', toState: 'doing' });
  const finish = (n: number, from: number, to: number) => { start(n, from); work(n, from, to); log(n, { kind: 'reported', at: ago(to - 1), title: 'Finished', description: 'This is a fictional report.', actor: placed(n), fromState: 'doing', toState: 'done' }); };
  const sol = { model: 'gpt-6.1-sol', effort: 'high' };

  // One child runs; the parent itself does not.
  start(140, 300); notes(140, 280, 200, 120);
  start(141, 60); work(141, 55, null, 'succeeded', owner(141), true, sol);
  finish(142, 280, 240);

  // Three Tasks run below, a grandchild and a child with two people among them; the parent works too.
  start(150, 400); notes(150, 380, 300, 200, 100, 30); work(150, 395, 350); work(150, 35, null);
  start(151, 50); work(151, 45, null, 'succeeded', owner(151), true, { model: 'opus', effort: 'medium' });
  start(152, 40); work(152, 38, null, 'succeeded', owner(152), true, sol);
  db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at) VALUES(?,?,?,?,0,1,?)`).run('child-member-152', 'T152', 'child-agent-member', 'claude', ago(30));
  work(152, 12, null, 'succeeded', 'child-member-152', true, { model: 'opus', effort: 'high' });
  start(153, 200); notes(153, 190, 60);
  start(154, 20); work(154, 18, null, 'succeeded', owner(154), true, { model: 'gpt-6.1-sol', effort: 'medium' });
  finish(155, 380, 330);

  // Only the parent runs; its child is done.
  start(170, 120); notes(170, 100); finish(171, 110, 80); work(170, 25, null);

  // Working, and nothing runs here or below now.
  // (A doing Task whose own Run ended without an end, a question or a request would be stopped by serve, so the parents
  // that do not run now have no Runs of their own, and the child that ran ends with a question to you.)
  start(160, 500); notes(160, 480, 300, 150);
  finish(161, 480, 400);
  start(162, 200);
  const ran = work(162, 195, 130, 'succeeded', owner(162), false);
  log(162, { kind: 'asked', at: ago(130), title: 'When should the migration take place', description: 'Choose the migration date.', actor: placed(162), askedTo: null, runId: ran,
    decide: [{ decide_question: 'Migration date', decide_choices: [{ decide_choice: 'This week', decide_choice_detail: 'This is a fictional option.' }, { decide_choice: 'Next week', decide_choice_detail: 'This is a fictional option.' }] }] });

  // The parent waits for your answer while its child runs.
  start(180, 240); notes(180, 220, 150);
  const asking = work(180, 140, 90, 'succeeded', owner(180), false);
  log(180, { kind: 'asked', at: ago(90), title: 'Which tone should the emails use', description: 'Choose the tone.', actor: placed(180), askedTo: null, runId: asking,
    decide: [{ decide_question: 'Tone', decide_choices: [{ decide_choice: 'Friendly', decide_choice_detail: 'This is a fictional option.' }, { decide_choice: 'Formal', decide_choice_detail: 'This is a fictional option.' }] }] });
  start(181, 70); work(181, 65, null, 'succeeded', owner(181), true, sol);

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
console.log(JSON.stringify({ root, rows: { one: 'T140', several: 'T150', none: 'T160', own: 'T170', asking: 'T180' }, running }));
setTimeout(() => { for (const fd of held) { unlock(fd); closeSync(fd); } process.exit(0); }, Number(values['hold-seconds']) * 1000);
