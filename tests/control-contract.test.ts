import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configEditSchema, DEFAULT_LIMITS, LIMIT_MINIMUM, noticeStateSchema } from '@alpacawork/contract';
import * as contract from '@alpacawork/contract';
import { REPORT_TITLE_GUIDE_WIDTH, REPORT_TITLE_MAX_WIDTH, reportTitleSchema, reportTitleWidth } from '@alpacawork/contract/fields';
import * as runs from '@alpacawork/runs';
import { bodyHash, controlTreeSchema, controlTaskSchema, controlRunSchema, requestInputSchema, requestReceiptSchema,
  requestRejectionSchema, controlRunFilesSchema,
  waitStates,
  taskLogSchema, taskRowFields,
  placeAgentInputSchema, placeAgentReceiptSchema, setResponsibleInputSchema, setResponsibleReceiptSchema,
  releaseAgentInputSchema, releaseAgentReceiptSchema, reviewInputSchema,
  placeMemberInputSchema, placeMemberReceiptSchema,
  releaseMemberInputSchema, releaseMemberReceiptSchema, type ControlTaskDTO } from '@alpacawork/contract/control';

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/contract-examples', name), 'utf8'));

test('report title uses grapheme display width and rejects only blank, multiline, or over twice the guide', () => {
  assert.equal(reportTitleWidth('abcd'), 4);
  assert.equal(reportTitleWidth('漢字'), 4);
  assert.equal(reportTitleWidth('e\u0301'), 1);
  assert.equal(reportTitleWidth('👩‍👩‍👧‍👦'), 2);
  assert.equal(reportTitleWidth('a漢👩‍👩‍👧‍👦'), 5);
  assert.equal(reportTitleSchema.safeParse('a'.repeat(REPORT_TITLE_GUIDE_WIDTH + 1)).success, true);
  assert.equal(reportTitleSchema.safeParse('漢'.repeat(REPORT_TITLE_MAX_WIDTH / 2)).success, true);
  for (const value of ['', '  ', 'one\ntwo', 'one\rtwo', '漢'.repeat(REPORT_TITLE_MAX_WIDTH / 2 + 1)])
    assert.equal(reportTitleSchema.safeParse(value).success, false, value);
});

test('list rows keep display titles while full descriptions stay in detail', () => {
  // A report of T12; only a creation or a mark change carries the user's mark.
  const task = controlTreeSchema.parse(fixture('tree.json')).tasks[1]!;
  const base = task.log[0]!;
  const logs = [
    taskLogSchema.parse({ ...base, id: 'Lreport', kind: 'reported', title: 'To the coordinator: report',
      description: 'Details', toState: 'waiting' }),
    taskLogSchema.parse({ ...base, id: 'Lgenerated', kind: 'review_approved', title: null,
      toState: 'done' }),
    taskLogSchema.parse({ ...base, id: 'Lreason', kind: 'review_approved', title: 'Approved with a reason',
      toState: 'done' }),
  ];
  const row = taskRowFields({ ...task, log: logs });
  assert.deepEqual(row.stateLog.map(entry => entry.title), ['To the coordinator: report', null, 'Approved with a reason']);
  assert.ok(row.stateLog.every(entry => !('description' in entry)));
  assert.equal(logs[0]!.description, 'Details');
  assert.equal(taskLogSchema.safeParse({ ...base, detail: 'Old shape' }).success, false);
});

test('wire Task IDs are flat while path names the Task file folder', () => {
  const task = controlTreeSchema.parse(fixture('tree.json')).tasks[1]!;
  assert.equal(task.id, 'T12');
  assert.equal(task.path, 'tasks/T12');
  for (const id of ['T1/T2', 'default/T12', 'T0', 'T1000000000', 'T01'])
    assert.equal(controlTaskSchema.safeParse({ ...task, id }).success, false, id);
});

test('a restored hold leaves the wait it paused, but an owner report after a hold begins a new one', () => {
  type Entry = Pick<ControlTaskDTO['log'][number], 'id' | 'toState' | 'actor'>;
  const asked: Entry = { id: 'asked', toState: 'waiting', actor: { kind: 'placement', placementId: 'P1' } };
  const hold: Entry = { id: 'hold', toState: 'held', actor: { kind: 'human' } };
  const restore: Entry = { id: 'restore', toState: 'waiting', actor: { kind: 'main', provider: 'codex', conversationId: 'C1' } };
  const note: Entry = { id: 'note', toState: null, actor: { kind: 'human' } };
  assert.deepEqual(waitStates([asked, hold, note, restore, hold, restore]).map(each => each.id), ['asked']);
  assert.deepEqual(waitStates([asked, hold]).map(each => each.id), ['asked', 'hold']);
  const renewed = { ...asked, id: 'renewed' };
  assert.deepEqual(waitStates([asked, hold, renewed]).map(each => each.id), ['asked', 'hold', 'renewed']);
});

test('a move exposes every former ancestor as a flat Task ID', () => {
  const task = controlTreeSchema.parse(fixture('tree.json')).tasks[0]!;
  const moved = { ...task, log: [...task.log, { id: 'Lformer', kind: 'moved',
    at: '2026-10-01T00:00:00Z', title: null, description: null, actor: { kind: 'human' },
    fromState: null, toState: null, formerAncestors: ['T13', 'T1'] }] };
  assert.deepEqual(controlTaskSchema.parse(moved).log.at(-1)?.formerAncestors, ['T13', 'T1']);
});

test('Control public fixtures match the wire contract', () => {
  const preflight = fixture('read-preflight.json') as { tree: { writable: boolean; errors: Array<{ code: string }> };
    get: { status: number; body: { error: { code: string } } }; serve: { cliExit: number; code: string } };
  assert.deepEqual([preflight.tree.writable, preflight.tree.errors[0]?.code,
    preflight.get.status, preflight.get.body.error.code, preflight.serve.cliExit, preflight.serve.code],
  [false, 'runs_unavailable', 409, 'invalid_root', 2, 'invalid_root']);
  const tree = controlTreeSchema.parse(fixture('tree.json'));
  const rootReview = controlTreeSchema.parse(fixture('root-review.json'));
  for (const example of [tree, rootReview]) {
    assert.ok(example.runs.length > 0);
    for (const run of example.runs) assert.equal(run.cwd, `/fixture/runs/${run.id}`);
  }
  const request = fixture('request.json') as Record<string, unknown>;
  requestInputSchema.parse(request.input);
  requestReceiptSchema.parse(request.receipt);
  requestRejectionSchema.parse(request.rejection);
  controlRunFilesSchema.parse(fixture('run-files.json'));
  const operations = fixture('placement-operations.json') as Record<string, { input: unknown; receipt: unknown }>;
  placeAgentInputSchema.parse(operations.placeAgent?.input);
  placeAgentReceiptSchema.parse(operations.placeAgent?.receipt);
  setResponsibleInputSchema.parse(operations.setResponsible?.input);
  setResponsibleReceiptSchema.parse(operations.setResponsible?.receipt);
  releaseAgentInputSchema.parse(operations.releaseAgent?.input);
  releaseAgentReceiptSchema.parse(operations.releaseAgent?.receipt);
  const review = fixture('review.json') as Record<string, { input: unknown }>;
  reviewInputSchema.parse(review.approve?.input);
  assert.equal(reviewInputSchema.safeParse(review.sendBack?.input).success, false);
  const participants = fixture('participant-operations.json') as Record<string, { input: unknown; receipt: unknown }>;
  placeMemberInputSchema.parse(participants.placeMember?.input);
  placeMemberReceiptSchema.parse(participants.placeMember?.receipt);
  releaseMemberInputSchema.parse(participants.releaseMember?.input);
  releaseMemberReceiptSchema.parse(participants.releaseMember?.receipt);
  const child = fixture('child-create.json') as { input: { parentId: string; expectedParentHash: string };
    authorizedRun: { taskId: string; placementId: string };
    receiptTask: { parentId: string; creationActor: { placementId: string } } };
  assert.match(child.input.expectedParentHash, /^[0-9a-f]{64}$/);
  assert.equal(child.input.parentId, child.authorizedRun.taskId);
  assert.deepEqual([child.receiptTask.parentId, child.receiptTask.creationActor.placementId],
    [child.input.parentId, child.authorizedRun.placementId]);
  assert.equal(tree.placements[0]?.runtime.displayState, 'running');
  assert.notEqual(tree.placements[0]?.agentId, tree.placements[2]?.agentId);
  assert.equal(tree.placements[0]?.profileKey, tree.placements[2]?.profileKey);
  assert.equal(tree.tasks[1]?.parentId, 'T1');
  assert.equal(rootReview.tasks[0]?.state, 'waiting');
  assert.equal(rootReview.tasks[0]?.log.at(-1)?.id, 'LfinishR1');
  assert.equal(rootReview.runs[0]?.state, 'succeeded');
  // The tree carries each Task's ball and its dialogues; a question's words are in its own record, and no turns.
  assert.deepEqual([tree.balls, tree.dialogues, tree.requestedByUser], [{}, [], {}]);
  assert.equal(controlTreeSchema.safeParse({ ...tree, turns: {} }).success, false);
  const reply = rootReview.replies.T1;
  assert.deepEqual([reply?.runId, reply?.state], ['R1', 'present']);
});

test('public Run cwd is a required absolute launch directory', () => {
  const run = controlTreeSchema.parse(fixture('tree.json')).runs[0]!;
  assert.equal(controlRunSchema.safeParse({ ...run, cwd: 'T1/index.md' }).success, false);
  assert.equal(controlRunSchema.safeParse({ ...run, cwd: '' }).success, false);
  assert.equal(controlRunSchema.safeParse({ ...run, cwd: null }).success, false);
  const { cwd: _cwd, ...olderRun } = run;
  assert.equal(controlRunSchema.safeParse(olderRun).success, false);
});

test('Task log wire rejects a removed wake marker and the removed waiting intent', () => {
  const task = controlTreeSchema.parse(fixture('tree.json')).tasks[0]!;
  assert.equal(controlTaskSchema.safeParse({ ...task, log: [...task.log,
    { ...task.log[0], id: 'Lextra', obsoleteFlag: true }] }).success, false);
  assert.equal(controlTaskSchema.safeParse({ ...task, log: [{ ...task.log[0], waitingIntent: null }] }).success, false);
});

test('Control tree rejects two current responsible placements for one task', () => {
  const tree = fixture('tree.json') as { placements: Array<Record<string, unknown>> };
  tree.placements[2] = { ...tree.placements[2], taskId: 'T1', responsible: true, active: true, endedAt: null };
  assert.equal(controlTreeSchema.safeParse(tree).success, false);
});

test('format 1 wire shapes, the unused send-back target and the project keys are not exported', () => {
  for (const name of ['taskSchema', 'treeSchema', 'workspaceSchema', 'mutationSchema'])
    assert.equal(name in contract, false, name);
  assert.equal('sendbackTarget' in runs, false);
  // A Task is named by its T number alone: no project key, reference or shown ID, and no project contract.
  for (const name of ['projectKeySchema', 'PROJECT_KEY_PATTERN', 'taskRefSchema', 'recordTaskIdSchema', 'parseTaskRef',
    'shownTaskId', 'SETTINGS_ORIGIN', 'projectSchema', 'projectGoalSchema', 'projectListSchema', 'projectGetSchema',
    'projectFoldersSchema'])
    assert.equal(name in contract, false, name);
});

test('limits.coordinator_run_minutes defaults to 30 and is a whole number of at least 1', () => {
  assert.equal(DEFAULT_LIMITS.coordinator_run_minutes, 30);
  assert.equal(LIMIT_MINIMUM.coordinator_run_minutes, 1);
  const limits = (coordinator_run_minutes: number) =>
    configEditSchema.safeParse({ limits: { ...DEFAULT_LIMITS, coordinator_run_minutes } }).success;
  assert.deepEqual([limits(1), limits(90), limits(0), limits(1.5)], [true, true, false, false]);
});

test('read marks are version 4, keyed by bare Task IDs', () => {
  const baseline = { log: 1, state: 'todo', body: bodyHash('') };
  const state = (version: number, key: string) => noticeStateSchema.safeParse({ version,
    checkpoint: { at: '2026-10-19T00:00:00Z', tasks: { [key]: baseline } }, reads: { [key]: baseline } }).success;
  assert.equal(state(4, 'T1'), true);
  assert.equal(state(3, 'T1'), false);
  assert.equal(state(4, 'default/T1'), false);
});

test('a folder listing is the workspace contract\'s: names only', () => {
  const listing = { path: '/code', parent: '/', home: '/home/person', folders: ['api', 'web'], truncated: false };
  assert.deepEqual(contract.foldersSchema.parse(listing), listing);
  assert.equal(contract.foldersSchema.safeParse({ ...listing, files: ['README.md'] }).success, false);
});


test('Task wire settings belong to every project and never a task', () => {
  const tasks = controlTreeSchema.parse(fixture('tree.json')).tasks;
  const project = tasks.find(task => task.kind === 'project')!;
  const task = tasks.find(task => task.kind === 'task')!;
  assert.equal(controlTaskSchema.safeParse({ ...project, settings: undefined }).success, false);
  assert.equal(controlTaskSchema.safeParse({ ...project, settings: {} }).success, false);
  assert.equal(controlTaskSchema.safeParse({ ...task, settings: { color: '#39659b' } }).success, false);
});

test('coordinator command seconds is a positive integer with default 10', () => {
  assert.equal(DEFAULT_LIMITS.coordinator_command_seconds, 10);
  for (const value of [0, -1, 1.5, Infinity]) assert.equal(configEditSchema.safeParse({ limits: { ...DEFAULT_LIMITS, coordinator_command_seconds: value } }).success, false);
  assert.equal(configEditSchema.safeParse({ limits: { ...DEFAULT_LIMITS, coordinator_command_seconds: 5 } }).success, true);
});
