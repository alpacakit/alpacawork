import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { fixtureAgentSetting, inertFixtureLaunch } from '../../tests/helpers/agent-stub.ts';
/**
 * Development-only: one synthetic scene for reading a Task's History as a conversation between its six parties.
 * Adds a small tree to a fresh copy of the small fixture. Every text is fictional; every Run is ended and inert.
 *
 *   T100 top (the user's) → T101 parent → T102 the open Task → T103, T104, T105 children; T106 is T102's sibling; T107 is T103's child.
 *
 * node scripts/dev-fixtures/timeline-scene.ts --dest /absolute/new/root   then serve that root and open T102, T100 or T103.
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { coordinatorRunRecordSchema } from '@alpacawork/contract/run';
import { openControlDatabase, taskHash } from '@alpacawork/db';
import { taskLogSchema } from '@alpacawork/raw/task-log-schema';
import { record } from '../../tests/runs-fixtures.ts';
import { copyWorkspace, createOriginal, profiles } from './fixture.ts';

export function createTimelineScene(root: string, cache?: string) {
const original = createOriginal({ ...profiles.small, seed: 'synthetic-v1' }, cache);
copyWorkspace(original.root, root);
const config = parse(readFileSync(join(root, 'config.yaml'), 'utf8'));
for (const id of ['claude', 'codex'] as const) config.agents[id] = { ...fixtureAgentSetting(id), enabled: false };
config.limits = { ...config.limits, automatic_per_placement: 0 };
writeFileSync(join(root, 'config.yaml'), stringify(config));

const internal = (n: number) => `scene-task-${n}`;
const owner = (n: number) => `scene-owner-${n}`;
const member = (n: number) => `scene-member-${n}`;
const TASKS: { n: number; parent: number | null; title: string; state: string; user?: boolean; goal: string }[] = [
  { n: 100, parent: null, title: 'Coordinate payment improvements', state: 'waiting', user: true, goal: 'Fewer support requests about failed payments' },
  { n: 101, parent: 100, title: 'Review payment screens', state: 'doing', goal: 'Clear guidance on the main payment screens' },
  { n: 102, parent: 101, title: 'Rewrite payment failure guidance', state: 'doing', goal: 'The screen explains the failure and the next step' },
  { n: 103, parent: 102, title: 'Investigate failure categories', state: 'done', goal: 'Failures fit into at most five categories' },
  { n: 104, parent: 102, title: 'Write the guidance', state: 'done', goal: 'Guidance is ready for each category' },
  { n: 105, parent: 102, title: 'Fix retry button behavior', state: 'done', goal: 'Retries never charge twice' },
  { n: 106, parent: 101, title: 'Investigate card issuer requirements', state: 'done', goal: 'Differences between issuers are listed' },
  { n: 107, parent: 103, title: 'Count past support requests', state: 'done', goal: 'Support request counts are available by reason' },
];

type Who = { placement: string } | 'human' | 'main';
const actor = (who: Who) => who === 'human' ? { kind: 'human' as const }
  : who === 'main' ? { kind: 'main' as const, provider: 'claude' as const, conversationId: 'scene-conversation', quote: 'Fix the failure guidance first' }
    : { kind: 'placement' as const, placementId: who.placement };
const as = (n: number): Who => ({ placement: owner(n) });

let minute = 0, runNumber = 1000, questionNumber = 0;
let sameMinute = false;
const at = (gap = 3) => { minute += sameMinute ? 0 : gap; return new Date(Date.parse('2026-11-01T00:00:00.000Z') + minute * 60_000).toISOString(); };

const db = openControlDatabase(root, { busyTimeoutMs: 1000 });
try {
  db.exec('BEGIN IMMEDIATE');
  const project = db.prepare(`SELECT id FROM tasks WHERE kind='project' LIMIT 1`).get()!.id as string;
  const start = '2026-11-01T00:00:00.000Z';
  const insertTask = db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,settings,revision,created_at,updated_at)
    VALUES(?,'task',?,?,?,?,'active',?,0,?,NULL,1,?,?)`);
  const insertPlacement = db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at) VALUES(?,?,?,?,?,1,?)`);
  const insertAgent = db.prepare('INSERT INTO agents(id,created_at) VALUES(?,?)');
  insertAgent.run('scene-agent-member', start);
  const insertRequest = db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state,wait_cycle_id)
    VALUES(?,?,?,1,?,'new',?,'instruction',?,?,'queued',?)`);
  const insertRun = db.prepare(`INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,?,?,'present')`);
  const insertLog = db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,?,?)');
  const insertText = db.prepare('INSERT INTO log_texts(log_id,text) VALUES(?,?)');
  const insertClosure = db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES(?,?)');
  const ordinal = new Map<number, number>();
  const lastRun = new Map<string, string>();

  const run = (n: number, placementId: string, requestId: string, role: 'owner' | 'worker', when: string, state: 'succeeded' | 'failed', reason: string | null, words: string, caller: { run: string } | null) => {
    const id = `R${++runNumber}`;
    insertRun.run(runNumber, JSON.stringify(record(id, { task: `T${n}`, placementId, requestId, agent: 'claude', role, caller, cwd: root, state, reason: reason as never,
      // A Run that failed did so after it started, so its row stands above the instruction that started it.
      created_at: when, started_at: when, ended_at: state === 'failed' ? new Date(Date.parse(when) + 60_000).toISOString() : when, exit: { code: state === 'failed' ? 1 : 0, signal: null },
      // The model and effort it ran with, as a real launch records them, so a member is named as History names one: opus(high).
      launch: inertFixtureLaunch('claude', { model: 'opus', effort: 'high' }) })), words, 'This is a fictional result.');
    lastRun.set(placementId, id);
    return id;
  };
  const log = (n: number, entry: Record<string, unknown>) => {
    const parsed = taskLogSchema.parse(entry);
    const place = ordinal.get(n) ?? 0;
    insertLog.run(parsed.id, internal(n), place, JSON.stringify(parsed));
    ordinal.set(n, place + 1);
    return parsed.id;
  };
  let logNumber = 0;
  const logId = () => `scene-log-${++logNumber}`;

  for (const task of TASKS) {
    insertTask.run(internal(task.n), task.n, task.parent ? internal(task.parent) : project, project, task.title, task.state, task.user ? 1 : 0, start, start);
    // Its goal and notes as values (task_values), as `task update --values-file` stores them.
    for (const [field, value] of Object.entries({ goal: task.goal, notes: 'This is fictional work.' }))
      db.prepare('INSERT INTO task_values(task_id,field_id,value) VALUES(?,?,?)').run(internal(task.n), field, JSON.stringify(value));
    insertPlacement.run(owner(task.n), `T${task.n}`, 'fixture-agent', task.n === 105 ? 'codex' : 'claude', 1, start);
    log(task.n, { id: logId(), kind: 'created', at: start, title: 'Task created', description: null, actor: task.parent ? actor(as(task.parent)) : actor('human'), fromState: null, toState: 'todo', userRequested: !!task.user });
  }
  insertPlacement.run(member(102), 'T102', 'scene-agent-member', 'claude', 0, start);

  /** The sender's wait cycle: a Request a placement sends belongs to one of its own Task's. */
  const cycles = new Set<string>();
  const cycle = (placement: string) => {
    const sender = placement.replace(/^scene-(owner|member)-/, ''), id = `scene-cycle-${sender}`;
    if (!cycles.has(id)) db.prepare('INSERT INTO wait_cycles(id,task_id,opened_at) VALUES(?,?,?)').run(id, `T${sender}`, start);
    cycles.add(id);
    return id;
  };
  const lastRequest = new Map<number, string>();
  /** The reports T102's owner took in, so its History says so on each of them, as a real parent's does. */
  const taken: { n: number; log: string }[] = [];
  /** An instruction to a Task's responsible or member, as its Request and the Run it started. */
  const request = (n: number, who: Who, words: string, to: 'owner' | 'member' = 'owner', outcome: { failed: string } | null = null) => {
    const when = at(), id = `scene-request-${++questionNumber}`, placement = to === 'owner' ? owner(n) : member(n);
    lastRequest.set(n, id);
    insertRequest.run(id, `T${n}`, placement, taskHash(internal(n), 1), words, JSON.stringify(actor(who)), when, typeof who === 'object' ? cycle(who.placement) : null);
    run(n, placement, id, to === 'owner' ? 'owner' : 'worker', when, outcome ? 'failed' : 'succeeded', outcome?.failed ?? null, words,
      typeof who === 'object' ? { run: lastRun.get(who.placement)! } : null);
    return id;
  };
  const report = (n: number, who: Who, title: string, description: string | null, state: { from: string; to: string } | null = null, extra: Record<string, unknown> = {}) => {
    const id = log(n, { id: logId(), kind: 'reported', at: at(), title, description, actor: actor(who), fromState: state?.from ?? null, toState: state?.to ?? null,
      ...(typeof who === 'object' && lastRun.has(who.placement) ? { runId: lastRun.get(who.placement) } : {}), ...extra });
    if (state?.to === 'done' && TASKS.find(task => task.n === n)?.parent === 102) taken.push({ n, log: id });
    return id;
  };
  /** A question: its summary (`text`) and what it asks, by default the title with the summary as its note. */
  const ask = (n: number, who: Who, title: string, text: string, to: number | null,
    decide: Record<string, unknown>[] = [{ decide_kind: 'choose', decide_question: title, decide_note: text }]) =>
    log(n, { id: logId(), kind: 'asked', at: at(), title, description: text, actor: actor(who), fromState: null, toState: null, askedTo: to === null ? null : `T${to}`,
      decide, ...(typeof who === 'object' && lastRun.has(who.placement) ? { runId: lastRun.get(who.placement) } : {}) });
  const answer = (n: number, who: Who, question: string, text: string) => {
    const id = log(n, { id: logId(), kind: 'answered', at: at(), title: null, description: null, actor: actor(who), fromState: null, toState: null, questionId: question });
    insertText.run(id, text); insertClosure.run(id, question);
    return id;
  };

  // The top Task: the user and the Coordinator start it, and its child reports back.
  request(100, 'human', 'I want fewer payment support requests. Start with failure guidance.');
  report(100, as(100), 'Plan prepared', '- Delegate the screen review to the child task\n- Check support request counts after completion', { from: 'todo', to: 'doing' });
  request(100, 'main', 'The user asked to fix failure guidance first. Change the order.');
  request(101, as(100), 'Review the main payment screens, starting with failure guidance.\n\nDone condition: the screen alone tells users what to do next.');
  request(102, as(101), 'Rewrite payment failure guidance.\n\n- Explain the failure on screen\n- Show one next action\n\nStop if the billing process itself needs to change.');
  report(102, as(102), 'Split into three parts', 'Separate members will handle failure categories, wording, and the retry button.', { from: 'todo', to: 'doing' });
  request(103, as(102), 'Group failures into at most five categories. Check past support request counts too.');
  request(104, as(102), 'Write guidance for each category, using the classification task results.');
  request(105, as(102), 'Ensure the retry button never charges twice.');
  request(102, as(102), 'List the current screen text.', 'member');
  report(102, { placement: member(102) }, 'Current screen text listed', 'There are 18 text entries across four screens. Six say “An error occurred”.');
  request(107, as(103), 'Count support requests from the past three months by reason.');
  report(107, as(107), 'Support requests counted by reason', 'Insufficient funds 41%, expired cards 23%, authentication 19%, network 11%, other 6%.', { from: 'doing', to: 'done' });
  report(103, as(103), 'Support request counts ready', 'The child results arrived. The top three categories account for over 80%.');
  const q1 = ask(103, as(103), 'Should refunded transactions count as failures', 'Refunded transactions look like failures to users.\n\nIncluding them increases “other”; excluding them undercounts actual support requests.', 102);
  answer(103, as(102), q1, 'Exclude them. Refunds are outside this guidance.');
  const q2 = ask(104, as(104), 'Which writing style should we follow', 'Existing screens mix full polite sentences and noun phrases. Which should we use?', 102);
  const q3 = ask(102, as(102), 'What is the writing style standard', 'A child asked about style. We will follow any product-wide standard.', 101);
  answer(102, as(101), q3, 'Use polite full sentences. Noun phrases are fine for short headings.');
  answer(104, as(102), q2, 'Use polite full sentences, with noun phrases only for short headings.');
  request(105, as(102), 'Based on the last result, keep a payment key for each screen.', 'owner', { failed: 'exit' });
  log(105, { id: logId(), kind: 'linked', at: at(), title: null, description: null, actor: actor(as(105)), fromState: 'doing', toState: 'error', runId: lastRun.get(owner(105)) });
  report(103, as(103), 'Grouped into five categories', 'The five categories are insufficient funds, expired cards, authentication, network, and other.\n\nRefunded transactions are excluded.', { from: 'doing', to: 'done' });
  report(102, { placement: owner(106) }, 'Issuer requirements ready', 'Issuer differences are listed. Some issuers require fixed authentication wording.');
  const q4 = ask(102, as(102), 'Does the billing text need legal review', 'The screen will say “You have not been charged”. If legal review is needed, I will request it first.', 100);
  answer(102, as(100), q4, 'Yes, but review can come last. Finalize the wording first.');
  request(102, 'human', 'Make the retry button the most prominent action.');
  request(105, as(102), 'Retry after the failure. Keep the key design and revise only the test environment.');
  report(104, as(104), 'Authentication wording needs review', 'Some issuers require fixed text that conflicts with the guidance.', null, { urgentReason: 'Some wording conflicts with the requirements' });
  report(102, as(102), 'Use the issuer authentication wording', 'Change the guidance for the one conflicting entry.');
  request(104, as(102), 'Revise the authentication guidance to match the issuer wording.');
  report(104, as(104), 'Wording complete', 'Each category has a heading, body, and next action.', { from: 'doing', to: 'done' });
  report(105, as(105), 'Duplicate charges prevented', 'Retries of the same payment produce a single charge.', { from: 'doing', to: 'done' });
  // Repeats a real History showed: the same report three times in a row, the same question asked twice and withdrawn, children reporting one after another.
  report(103, as(103), 'Category evidence added', 'Each category lists the source of its counts.', { from: 'doing', to: 'done' });
  report(106, as(106), 'Issuer differences added', 'No differences were found outside authentication.', { from: 'doing', to: 'done' });
  report(105, as(105), 'Retry tests added', 'Added three tests for duplicate charges.', { from: 'doing', to: 'done' });
  sameMinute = true;
  report(102, as(102), 'Milestone report: wording is still pending', 'Retries are fixed; wording awaits review.', { from: 'doing', to: 'waiting' });
  report(102, as(102), 'Milestone report: wording is still pending', 'Retries are fixed; wording awaits review.', { from: 'waiting', to: 'waiting' });
  report(102, as(102), 'Milestone report: wording is still pending', 'Retries are fixed; wording awaits review.', { from: 'waiting', to: 'waiting' });
  sameMinute = false;
  request(102, 'human', 'Finish the wording before reporting.');
  for (let i = 0; i < 2; i++) {
    const asked = ask(102, as(102), 'Should the guidance support screen readers', 'Screen reader support adds one wording review.', null);
    insertClosure.run(log(102, { id: logId(), kind: 'question_withdrawn', at: at(), title: null, description: null, actor: actor(as(102)), fromState: null, toState: null, questionId: asked }), asked);
  }
  report(102, 'human', 'Put on hold', null, { from: 'doing', to: 'held' });
  report(102, 'human', 'Hold removed', null, { from: 'held', to: 'doing' });
  report(102, { placement: member(102) }, 'Screens checked', 'Confirmed the updated text on all four screens.');
  report(106, as(106), 'Requirements list delivered', 'The list is also recorded in the guidance task.', { from: 'doing', to: 'done' });
  // The same words over different bodies, which stay two rows, and the same words over the same body, which are one.
  report(104, as(104), 'Wording updated', 'Shortened the headings.', { from: 'doing', to: 'done' });
  report(104, as(104), 'Wording updated', 'Aligned the polite wording in the body.', { from: 'doing', to: 'done' });
  ask(102, as(102), 'How many failure reasons should we show', 'Choose how to display failure reasons.', null, [{ decide_kind: 'choose', decide_question: 'Failure reason display', decide_choices: [
    { decide_choice: 'All', decide_choice_detail: 'Show all five reasons separately.' },
    { decide_choice: 'Top three', decide_choice_detail: 'Show the top three separately and group the rest as “other”.', decide_choice_recommended: 'They account for over 80%.' }] }]);
  report(101, as(101), 'Waiting for failure guidance', 'Continue the remaining screens after the guidance is finalized.', { from: 'doing', to: 'held' });
  const q5 = ask(100, as(100), 'Proceed to the next improvement', 'Failure guidance is nearly finished. May we work on the receipt screen next?', null);
  answer(100, 'human', q5, 'Please proceed.');
  report(100, as(100), 'Review progress summarized', 'The guidance covers the top three support request categories.', { from: 'doing', to: 'waiting' }, { });
  const insertReturn = db.prepare(`INSERT INTO returns(id,request_id,to_task_id,outcome,cause_log_id,created_at) VALUES(?,NULL,'T102','work_changed',?,?)`);
  const insertDelivery = db.prepare(`INSERT INTO return_deliveries(return_id,wake_request_id,reserved_at,received_at,consumed_at) VALUES(?,?,?,?,?)`);
  // The automatic continuation that took them in: it writes nothing of its own, so each report keeps its row.
  const wake = 'scene-request-wake', wakeAt = at(0);
  db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state,wait_cycle_id)
    VALUES(?,'T102',?,1,?,'new',?,'return_continuation',?,?,'queued',NULL)`).run(wake, owner(102), taskHash(internal(102), 1), 'Child results arrived.', JSON.stringify(actor(as(102))), wakeAt);
  run(102, owner(102), wake, 'owner', wakeAt, 'succeeded', null, 'Child results arrived.', null);
  for (const { log: cause } of taken) {
    const id = `scene-return-${cause}`, when = at(0);
    insertReturn.run(id, cause, when);
    insertDelivery.run(id, wake, when, when, when);
  }
  // You talk about T102 with the Coordinator, which replies: one record of a screen message and the Run that answered it.
  const said = 'scene-dialogue-request', saidAt = at(), conversation = '10000000-0000-4000-8000-000000000102';
  db.prepare('INSERT INTO coordinator_conversations(id,started_at) VALUES(?,?)').run(conversation, start);
  db.prepare(`INSERT INTO requests(id,conversation_id,mode,body,purpose,author,submitted_at,delivery_state)
    VALUES(?,?,'new',?,'instruction',?,?,'queued')`).run(said, conversation, 'When will the failure guidance be ready?', JSON.stringify({ kind: 'human' }), saidAt);
  const replyNumber = ++runNumber, reply = `R${replyNumber}`;
  insertRun.run(replyNumber, JSON.stringify(coordinatorRunRecordSchema.parse({ ...record(reply), task: null, placementId: null, requestId: said, agent: 'claude', role: 'coordinator', caller: null, cwd: root,
    state: 'succeeded', reason: null, created_at: saidAt, started_at: saidAt, ended_at: saidAt, exit: { code: 0, signal: null }, ...{ conversationId: conversation, message: { context: 'T102', tasks: ['T102'], attachments: [], intent: null } },
    launch: inertFixtureLaunch('claude', { model: 'opus', effort: 'high' }) })), 'When will the failure guidance be ready?', 'Wording review is still pending.\n\nOnce reviewed, it should be ready today.');
  db.prepare('INSERT INTO task_dialogues(task_uuid,request_id) VALUES(?,?)').run(internal(102), said);
  db.prepare('UPDATE task_sequence SET next_number=?').run(200);
  db.prepare('UPDATE run_sequence SET next_number=?').run(runNumber + 1);
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.exec('PRAGMA journal_mode=DELETE');
} finally { db.close(); }
return { root, open: { middle: 'T102', top: 'T100', child: 'T103' } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { dest: { type: 'string' }, cache: { type: 'string' } } });
  if (!values.dest) throw Error('--dest is required');
  console.log(JSON.stringify(createTimelineScene(values.dest, values.cache)));
}
