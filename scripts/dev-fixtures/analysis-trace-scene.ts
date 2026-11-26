/** Fictional workspace for the analysis overview and a task's timeline. All saved Runs are ended and inert. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { readAnswerParts, type FieldItem } from '@alpacawork/contract';
import { eventSchema, PROTOCOL } from '@alpacawork/contract/run-protocol';
import {
  RUN_FILES, runConditionsSchema, runFolder, runRecordSchema, stepJournalEntrySchema, type RunRecord,
} from '@alpacawork/contract/run';
import { openControlDatabase, taskHash } from '@alpacawork/db';
import { requestActionReasonSchema, type TakenReason, type TaskBaseState } from '@alpacawork/raw';
import { storedTaskLogSchema, type TaskActor, type TaskLog } from '@alpacawork/raw/task-log-schema';
import { fixtureAgentSetting, inertFixtureLaunch } from '../../tests/helpers/agent-stub.ts';
import { record } from '../../tests/runs-fixtures.ts';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from './fixture.ts';

const MINUTE = 60_000, DAY = 1440;
const iso = (ms: number) => new Date(ms).toISOString();
const human = { kind: 'human' } as const;
const actor = (placementId: string) => ({ kind: 'placement' as const, placementId });
const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

type Task = { id: string; key: string; owner: string; ordinal: number };
type Step = { command: string; from: number; to: number; output: string; exit?: number; stopped?: true };
type RunOptions = {
  placement?: string;
  caller?: string;
  firstRunId?: string;
  replacement?: string;
  model?: string;
  steps?: Step[];
};
type RequestOptions = RunOptions & {
  author?: TaskActor;
  cycle?: string;
  reviewRun?: string;
  taken?: TakenReason;
  purpose?: 'return_continuation';
};

const topics = [
  'Clarify the invoice reminder', 'Add a billing contact', 'Align the receipt footer',
  'Show the tax breakdown', 'Make the refund link visible', 'Simplify the account switcher',
  'Add a preview for receipts', 'Fix the billing date filter', 'Shorten the failed payment heading',
  'Add a help link for VAT', 'Update the invoice export', 'Review the overdue banner',
  'Show the card expiry date', 'Adjust the plan comparison', 'Tidy the payment method form',
  'Group past transactions by month', 'Explain the next charge', 'Add a print view for invoices',
  'Show receipt actions on mobile', 'Improve the confirmation email', 'Adjust the renewal reminder',
  'Align the balance in the summary', 'Check the empty invoice list', 'Clarify the payment status',
  'Move the default card badge', 'Review the billing history sort', 'Improve the account menu focus',
  'Show the refund destination', 'Check receipt links in email',
];

const corrections: { words: string; fixes: TakenReason['aspects'] }[] = [
  { words: 'Move the payment total above the action buttons.', fixes: ['look_feel'] },
  { words: 'Keep the primary action in view while the panel scrolls.', fixes: ['look_feel'] },
  { words: 'Preserve the selected card when the panel closes.', fixes: ['behavior'] },
  { words: 'Give the receipt preview more space on a phone.', fixes: ['look_feel'] },
  { words: 'Use “Download receipt” for the link.', fixes: ['wording'] },
  { words: 'Keep keyboard focus visible on the receipt action.', fixes: ['look_feel', 'behavior'] },
  { words: 'Match the spacing of the other billing panels.', fixes: ['look_feel'] },
];

function choiceQuestion(question: string, kind: 'choose' | 'accept', recommended: string, alternative: string): FieldItem {
  return { decide_kind: kind, decide_question: question, decide_choices: [
    { decide_choice: recommended, decide_choice_recommended: 'It matches the rest of the billing interface.' },
    { decide_choice: alternative },
  ] };
}

function writeRunFiles(root: string, run: RunRecord, workspaceId: string, steps: Step[], clock: (minute: number) => string,
  version: string, skill: string) {
  const folder = runFolder(root, run.id);
  mkdirSync(folder, { recursive: true });
  const stdout: unknown[] = [], journal: unknown[] = [];
  for (const [index, step] of steps.entries()) {
    const id = `call-${index}`, line = stdout.length, exit = step.exit ?? (step.stopped ? 143 : 0);
    const item = { id, type: 'command_execution', command: step.command };
    stdout.push({ type: 'item.started', item: { ...item, status: 'in_progress' } },
      { type: 'item.completed', item: { ...item, status: exit ? 'failed' : 'completed', exit_code: exit, aggregated_output: step.output } });
    journal.push(
      stepJournalEntrySchema.parse({ event: 'start', line, id, at: clock(step.from), source: 'observed',
        fingerprint: { line: step.command, bodyDigest: null }, parentId: null }),
      stepJournalEntrySchema.parse({ event: 'end', line, id, at: clock(step.to), source: 'observed', state: exit ? 'failed' : 'done',
        output: { chars: step.output.length, digest: digest(step.output), whole: true } }),
    );
    if (step.stopped) {
      const attempt = randomUUID(), events = join(folder, 'protocol', attempt, 'events');
      mkdirSync(events, { recursive: true });
      const event = eventSchema.parse({ protocol: PROTOCOL, workspaceId, runId: run.id, attemptId: attempt, seq: 1,
        occurredAt: clock(step.to), previousDigest: null, type: 'command_stopped',
        payload: { session: 1, started: clock(step.from), signal: 'SIGTERM', seconds: (step.to - step.from) * 60, pids: [], failed: [] } });
      writeFileSync(join(events, '000000000001.json'), JSON.stringify(event));
    }
  }
  const writeLines = (file: string, lines: unknown[]) =>
    writeFileSync(join(folder, file), lines.map(line => JSON.stringify(line) + '\n').join(''));
  writeLines(RUN_FILES.stdout, stdout);
  writeLines(RUN_FILES.steps, journal);
  writeFileSync(join(folder, RUN_FILES.conditions), JSON.stringify(runConditionsSchema.parse({
    v: 1, observedAt: run.started_at, version, release: null, source: null,
    cwd: { path: root, commit: null }, skills: [{ scope: 'project', folder: '/fictional/.agents/skills',
      items: [{ name: 'billing-review', digest: digest(skill) }] }], instructions: [],
  })));
}

function seedRecords(db: ReturnType<typeof openControlDatabase>, root: string, start: number, now: number) {
  const clock = (minute: number) => iso(start + minute * MINUTE);
  const currentMinute = Math.floor((now - start) / MINUTE);
  const project = String(db.prepare("SELECT id FROM tasks WHERE kind='project' LIMIT 1").get()!.id);
  const workspaceId = String(db.prepare('SELECT id FROM workspace_identity').get()!.id);
  const insertTask = db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,revision,created_at,updated_at)
    VALUES(?,'task',?,?,?,?,'active',?,0,?,1,?,?)`);
  const insertValue = db.prepare('INSERT INTO task_values(task_id,field_id,value) VALUES(?,?,?)');
  const insertPlacement = db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at)
    VALUES(?,?,'fixture-agent','codex',?,1,?)`);
  const insertRequest = db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,
    submitted_at,delivery_state,wait_cycle_id,head_run_id,about_run_id,reason)
    VALUES(?,?,?,1,?,'new',?,?,?,?,'queued',?,?,?,?)`);
  const insertRun = db.prepare("INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,?,?,'present')");
  const insertLog = db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry,request_id) VALUES(?,?,?,?,?)');
  const insertClosure = db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES(?,?)');
  const insertText = db.prepare('INSERT INTO log_texts(log_id,text) VALUES(?,?)');
  let taskNumber = 100, runNumber = 1000;
  const log = (task: Task, at: number, kind: TaskLog['kind'], fields: Partial<TaskLog> = {}) => {
    const id = `${task.key}-log-${task.ordinal}`;
    const event = storedTaskLogSchema.parse({
      id, at: clock(at), kind, actor: human, title: null, description: null, fromState: null, toState: null, ...fields,
    });
    insertLog.run(id, task.key, task.ordinal++, JSON.stringify(event), null);
    return id;
  };
  const task = (title: string, from: number, to: number, state: TaskBaseState, parent?: Task): Task => {
    const number = taskNumber++, key = `trace-scene-${number}`;
    const row = { id: `T${number}`, key, owner: `${key}-owner`, ordinal: 0 };
    insertTask.run(key, number, parent?.key ?? project, project, title, state, parent ? 0 : 1, clock(from), clock(to));
    insertPlacement.run(row.owner, row.id, 1, clock(from));
    log(row, from, 'created', { title: 'Task created', actor: parent ? actor(parent.owner) : human, toState: 'todo', userRequested: !parent });
    return row;
  };
  const run = (task: Task, requestId: string, words: string, created: number, started: number, ended: number,
    options: RunOptions = {}) => {
    const number = ++runNumber, id = `R${number}`, placementId = options.placement ?? task.owner;
    const failed = !!options.replacement;
    const saved = runRecordSchema.parse(record(id, {
      task: task.id, placementId, requestId, agent: 'codex', role: placementId === task.owner ? 'owner' : 'worker',
      cwd: root, caller: options.caller ? { run: options.caller } : null,
      ...(options.firstRunId ? { attempt: 1, firstRunId: options.firstRunId } : {}),
      ...(options.replacement ? { supersededBy: options.replacement, availability: { cause: 'model_capacity' } } : {}),
      state: failed ? 'failed' : 'succeeded', reason: failed ? 'exit' : null,
      created_at: clock(created), started_at: clock(started), ended_at: clock(ended),
      exit: { code: failed ? 1 : 0, signal: null },
      // The usage reader requires a recorded launch. These are fictional process IDs on ended Runs.
      pids: { manager: 2_000_000_000 + number * 2, agent: 2_000_000_001 + number * 2 },
      launch: inertFixtureLaunch('codex', { model: options.model ?? 'gpt-6.1-terra', effort: 'medium' }),
      usage: { includesEarlier: false, conversation: null, run: {
        input: 12_000 + (number % 19) * 730, output: 820 + (ended - started) * 17,
        cacheRead: (number % 8) * 1_240, cacheWrite: (number % 5) * 430,
      } },
    }));
    insertRun.run(number, JSON.stringify(saved), words, failed ? 'The provider reached capacity before the preview could be published.' : 'The billing changes are ready to inspect.');
    writeRunFiles(root, saved, workspaceId, options.steps ?? [{
      command: 'git diff --stat', from: started + 1, to: started + 2, output: ' billing-panel.ts | 12 ++++++++----',
    }], clock, started < -9 * DAY ? '0.1.6' : '0.1.7', started < -18 * DAY ? 'Initial billing checklist' : 'Add keyboard and mobile checks');
    return id;
  };
  const request = (task: Task, words: string, created: number, started: number, ended: number,
    options: RequestOptions = {}) => {
    const id = `${task.key}-request-${runNumber + 1}`;
    const { placement = task.owner, author = human, cycle = null, reviewRun = null, taken } = options;
    insertRequest.run(id, task.id, placement, taskHash(task.key, 1), words,
      options.purpose ?? (reviewRun ? 'review_send_back' : 'instruction'), JSON.stringify(author), clock(created), cycle, reviewRun, reviewRun,
      taken ? JSON.stringify(requestActionReasonSchema.parse({ taken })) : null);
    const runId = run(task, id, words, created, started, ended, options);
    if (!options.purpose) insertLog.run(id, task.key, task.ordinal++, null, id);
    return { id, runId };
  };
  const changeState = (task: Task, at: number, fromState: TaskBaseState, toState: TaskBaseState, runId?: string, originCauseId?: string) =>
    log(task, at, 'linked', { fromState, toState, runId, originCauseId });
  const ask = (task: Task, at: number, title: string, decide: FieldItem[], runId: string) =>
    log(task, at, 'asked', { title, description: 'Please choose so we can continue.', actor: actor(task.owner), askedTo: null, decide, runId });
  const answer = (task: Task, at: number, questionId: string, decide: FieldItem[], words: string) => {
    const id = log(task, at, 'answered', { questionId, answerParts: { source: 'user', ...readAnswerParts(decide, words) } });
    insertClosure.run(id, questionId);
    insertText.run(id, words);
  };
  const submit = (task: Task, at: number, runId: string) =>
    log(task, at, 'reported', { actor: actor(task.owner), title: 'Ready for review', fromState: 'doing', toState: 'waiting', runId });
  const accept = (task: Task, at: number, runId: string, fromState: 'waiting' | 'doing' = 'waiting') =>
    log(task, at, 'review_approved', { title: 'Result accepted', fromState, toState: 'done', runId });

  // Keep the small fixture's browsing data. Clear its top-level request marker so the overview counts this scene's work.
  const starter = db.prepare("SELECT id,updated_at FROM tasks WHERE external_id='T2' AND user_requested=1 AND base_state<>'waiting'").get();
  if (starter) {
    const at = iso(Date.parse(String(starter.updated_at)) + MINUTE);
    const ordinal = Number(db.prepare('SELECT max(ordinal)+1 AS next FROM task_log WHERE task_id=?').get(starter.id)!.next);
    const id = 'trace-scene-starter-unrequested';
    insertLog.run(id, starter.id, ordinal, JSON.stringify(storedTaskLogSchema.parse({
      id, kind: 'user_request_changed', at, actor: human,
      title: 'Keep as reference', description: null, fromState: null, toState: null, userRequested: false,
    })), null);
    db.prepare('UPDATE tasks SET user_requested=0,updated_at=? WHERE id=?').run(at, starter.id);
  }

  const showcase = task('Refine the payment confirmation panel', 0, 31 * 60, 'done');
  const startWords = 'Make the payment confirmation panel easier to check on desktop and mobile.';
  insertValue.run(showcase.key, 'goal', JSON.stringify(startWords));
  insertValue.run(showcase.key, 'notes', JSON.stringify('Review: https://github.com/fictional-billing-example/checkout/pull/101'));
  const failures: Step[] = [8, 10, 12].map(from => ({
    from, to: from + 1, command: 'pnpm test billing-preview', output: 'Preview failed: receipt sample is missing.', exit: 1,
  }));
  const initial = request(showcase, startWords, 0, 7, 26, {
    replacement: `R${runNumber + 2}`,
    steps: [...failures, { from: 14, to: 21, command: 'pnpm test billing-render', output: '42 billing renders passed.' },
      { from: 22, to: 25, command: 'pnpm preview:check', output: 'Preview check exceeded its time limit.', stopped: true }],
  });
  changeState(showcase, 7, 'todo', 'doing', initial.runId, initial.id);
  const model = 'gpt-6.2-sol';
  const replacement = run(showcase, initial.id, startWords, 26, 27, 38, {
    firstRunId: initial.runId, model, steps: [28, 31, 34].map(from => ({
      from, to: from + 1, command: 'cat billing/receipt-layout.md', output: 'Receipt layout: total, payment method, download link.',
    })),
  });

  const child = task('Check payment confirmation on narrow screens', 8, 39, 'done', showcase);
  const member = `${showcase.key}-member`;
  db.prepare('INSERT INTO agents(id,created_at) VALUES(?,?)').run('trace-scene-reviewer', clock(8));
  db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at)
    VALUES(?,?,'trace-scene-reviewer','codex',0,1,?)`).run(member, showcase.id, clock(8));
  const cycle = 'trace-scene-delegation';
  db.prepare('INSERT INTO wait_cycles(id,task_id,opened_at) VALUES(?,?,?)').run(cycle, showcase.id, clock(8));
  const delegation = { caller: initial.runId, author: actor(showcase.owner), cycle };
  request(showcase, 'Check keyboard focus and tab order.', 8, 9, 27, {
    ...delegation, placement: member,
    steps: [{ from: 15, to: 18, command: 'pnpm test billing-keyboard', output: 'Keyboard focus remains visible after closing the preview.' }],
  });
  const narrow = request(child, 'Check the receipt preview at a narrow width.', 8, 10, 17, {
    ...delegation,
    steps: [{ from: 14, to: 17, command: 'pnpm test billing-mobile', output: 'The receipt actions fit at 390 pixels.' }],
  });
  changeState(child, 10, 'todo', 'doing', narrow.runId, narrow.id);
  const wide = request(child, 'Also check the preview at tablet width.', 18, 19, 39, delegation);
  log(child, 39, 'reported', { actor: actor(child.owner), title: 'Preview checked at both widths', fromState: 'doing', toState: 'done', runId: wide.runId });
  db.prepare('UPDATE wait_cycles SET closed_at=? WHERE id=?').run(clock(39), cycle);

  const review = 'May PR #101 go into main?';
  const decision = [choiceQuestion(review, 'accept', 'Merge now', 'Keep open')];
  // The fourth wait runs from the local evening to the next morning. No background tasks have user activity in that interval.
  const rounds = [[37, 55], [120, 140], [290, 320], [720, 1260], [1320, 1340], [1510, 1540], [1690, 1720], [1846, 1858]];
  let reviewing = replacement;
  for (const [index, [askedAt, repliedAt]] of rounds.entries()) {
    const questionId = ask(showcase, askedAt, review, decision, reviewing);
    const correction = corrections[index];
    if (!correction) {
      answer(showcase, repliedAt, questionId, decision, '1-Merge');
      accept(showcase, 31 * 60, reviewing, 'doing');
      break;
    }
    const revision = request(showcase, correction.words, repliedAt, repliedAt + 1, rounds[index + 1]![0] + 1, {
      model, taken: { code: 'fix', cause: 'shortfall', aspects: correction.fixes, of: null },
    });
    const withdrawal = log(showcase, repliedAt, 'question_withdrawn', {
      actor: actor(showcase.owner), questionId, runId: reviewing, originCauseId: revision.id,
    });
    insertClosure.run(withdrawal, questionId);
    reviewing = revision.runId;
  }

  const question = [choiceQuestion('Where should the supporting detail appear?', 'choose', 'Inline detail', 'Separate panel')];
  for (const [index, title] of topics.entries()) {
    // The last ten ordinary tasks are dense enough for the 7-day view. Two more close during the showcase's first wait.
    const at = index < 17 ? (-25 + index * 1.14) * DAY : index < 27 ? -3 * DAY + (index - 17) * 4 * 60 : 25 + (index - 27) * 3;
    const duringReview = index >= 27;
    const sendBack = !duringReview && index % 5 === 2;
    const end = at + (duringReview ? 45 : sendBack ? 200 : 100 + index % 6 * 11);
    const item = task(title, at, end, 'done');
    const first = request(item, title + '.', at, at + 1, at + 9);
    changeState(item, at + 1, 'todo', 'doing', first.runId, first.id);

    let reviewRun = first.runId;
    if (duringReview || index % 3 === 0) {
      const questionId = ask(item, at + 8, 'Placement of supporting detail', question, first.runId);
      const replies = ['1-Inline', '1-other Put it next to the receipt link.', '1-Separate'];
      const words = replies[(duringReview ? index : Math.floor(index / 3)) % replies.length]!;
      const answerAt = duringReview ? index === 27 ? 40 : 46 : at + 17;
      answer(item, answerAt, questionId, question, words);
      reviewRun = request(item, words, answerAt, answerAt + 1, answerAt + 8,
        { author: actor(item.owner), purpose: 'return_continuation' }).runId;
    } else if (index % 7 === 1) {
      reviewRun = request(item, 'Also check the text in the printed receipt.', at + 12, at + 13, at + 23, {
        taken: { code: 'addition', cause: null, aspects: [], of: null },
      }).runId;
    }
    submit(item, duringReview ? at + 28 : at + 45, reviewRun);
    if (sendBack) {
      const back = request(item, 'Use the same receipt terms as the billing page.', at + 65, at + 66, at + 100,
        { reviewRun, taken: { code: 'fix', cause: 'shortfall', aspects: ['wording'], of: null } });
      changeState(item, at + 66, 'waiting', 'doing', back.runId, back.id);
      reviewRun = back.runId;
      submit(item, at + 99, reviewRun);
    }
    accept(item, end, reviewRun);
  }

  for (const [title, at, state] of [
    ['Pause the payment survey draft', -15 * DAY, 'stopped'],
    ['Stop the receipt email redesign', -DAY, 'stopped'],
    ['Document supported receipt sizes', -2.5 * DAY, 'done'],
  ] as const) {
    const item = task(title, at, at + 55, state);
    const work = request(item, title + '.', at, at + 1, at + 30);
    changeState(item, at + 1, 'todo', 'doing', work.runId, work.id);
    log(item, at + 55, 'reported', { title, actor: state === 'done' ? actor(item.owner) : human, fromState: 'doing', toState: state,
      runId: state === 'done' ? work.runId : undefined });
  }

  for (const [index, title] of ['Review the refund panel on mobile', 'Choose a default receipt format', 'Check the next-charge preview'].entries()) {
    const at = currentMinute - (index + 1) * 47, state = index === 1 ? 'doing' : 'waiting';
    const item = task(title, at, at + 12, state);
    const work = request(item, title + '.', at, at + 1, at + 15);
    changeState(item, at + 1, 'todo', 'doing', work.runId, work.id);
    if (state === 'doing') ask(item, at + 12, 'Default receipt format',
      [choiceQuestion('Which receipt format should be the default?', 'choose', 'PDF receipt', 'Plain text')], work.runId);
    else submit(item, at + 12, work.runId);
  }

  db.prepare('UPDATE task_sequence SET next_number=?').run(taskNumber);
  db.prepare('UPDATE run_sequence SET next_number=?').run(runNumber + 1);
  return { root, showcaseTask: showcase.id, overnightAt: clock(16 * 60), runAt: clock(16) };
}

export function createAnalysisTraceScene(dest: string, cache?: string) {
  const root = resolve(dest);
  const original = createOriginal({ ...profiles.small, seed: 'synthetic-v1' }, cache);
  copyWorkspace(original.root, root);
  try {
    const configPath = join(root, 'config.yaml');
    const config = parse(readFileSync(configPath, 'utf8'));
    config.agents.codex = { ...fixtureAgentSetting('codex'), enabled: false };
    config.limits = { ...config.limits, automatic_per_placement: 0 };
    writeFileSync(configPath, stringify(config));

    const now = Date.now();
    // The showcase finishes at about 16:00. Leave room after it for the three unfinished tasks.
    const midnight = new Date(now);
    if (midnight.getHours() < 19) midnight.setDate(midnight.getDate() - 1);
    midnight.setHours(0, 0, 0, 0);
    const start = midnight.getTime() - 15 * 60 * MINUTE;
    const db = openControlDatabase(root, { busyTimeoutMs: 1000 });
    try {
      db.exec('BEGIN IMMEDIATE');
      const result = seedRecords(db, root, start, now);
      db.exec('COMMIT');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.exec('PRAGMA journal_mode=DELETE');
      return result;
    } finally { db.close(); }
  } catch (error) {
    removeWorkspace(root);
    throw error;
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { dest: { type: 'string' }, cache: { type: 'string' } } });
  if (!values.dest) throw new Error('Usage: node scripts/dev-fixtures/analysis-trace-scene.ts --dest NEW_ROOT [--cache CACHE]');
  console.log(JSON.stringify(createAnalysisTraceScene(values.dest, values.cache)));
}
