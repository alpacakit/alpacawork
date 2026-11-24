import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskHistoryWindowSchema } from '@alpacawork/contract/control';
import { commandFetch } from './helpers/command-fetch.ts';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { assignResponsible } from './helpers/control-fixture.ts';
import { asRun, call, cli, fixture, userBall } from './return-repro.fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Seat = { id: string; revision: number };

async function sibling(h: Fixture, title: string): Promise<Seat> {
  const [task] = (await h.commands.create({
    parentId: h.T.id, userRequested: false, tasks: [{ title }],
  })).tasks;
  const placement = await assignResponsible(h.root, task!, 'fake');
  return { id: task!.id, revision: placement.revision };
}

async function request(h: Fixture, target: Seat, from?: string, lent?: string, answers?: string) {
  const args = answers ? ['--answers', answers] : [
    '--expected-task-hash', (await h.current(target.id)).hash,
    '--expected-placement-revision', String(target.revision),
  ];
  const result = await call(h.root, ['task', 'request', '--task', target.id, '--instruction-file', '-',
    ...args, ...(lent ? ['--lend-task', lent] : [])],
  from ? asRun(h.root, from) : {}, 'Please work on this task.');
  assert.equal(result.outcome.kind, 'request_accepted');
  return result.outcome.request as { requestId: string; runId: string };
}

async function setup(t: Parameters<typeof fixture>[0]) {
  const h = await fixture(t);
  const a = { id: h.C.id, revision: h.OC.revision };
  const b = await sibling(h, 'Verification');
  const parent = await h.human(h.T.id, h.OT.revision);
  h.start(parent.runId);
  const pass = () => new ReturnRouter(h.root).pass(undefined, { project: h.project });
  const wakes = async (task: string) => {
    const { acceptedRequestIds } = await pass();
    const requests = acceptedRequestIds.map(id => h.store.getRequest(id)!);
    assert.deepEqual(requests.map(r => r.taskId), [task]);
    return requests[0]!.runId!;
  };
  return { h, a, b, parent, pass, wakes };
}

test('three sibling verification rounds wake the borrower and wake the parent only after its report', async t => {
  const { h, a, b, parent, wakes } = await setup(t);
  const loan = await request(h, a, parent.runId, b.id);
  h.end(parent.runId);
  let aRun = loan.runId;
  for (let index = 0; index < 3; index++) {
    h.start(aRun);
    const verification = await request(h, b, aRun);
    assert.equal(h.store.getRequest(verification.requestId)?.loanRequestId, loan.requestId);
    await assert.rejects(h.report(aRun, a.id, 'done'), { code: 'conflict' });
    h.end(aRun);
    h.start(verification.runId);
    if (index === 0) {
      h.end(verification.runId, 'failed');
    } else {
      await h.report(verification.runId, b.id, 'done');
      h.end(verification.runId);
    }
    aRun = await wakes(a.id);
    const returned = h.store.readReturns().find(row => row.requestId === verification.requestId);
    assert.equal(returned?.toTaskId, a.id);
    assert.equal(returned?.outcome, index === 0 ? 'failed' : 'succeeded');
    assert.equal(h.store.getRequest(loan.requestId)?.loanEndedAt, undefined);
    assert.equal(h.store.readRequests().filter(row => row.taskId === h.T.id).length, 1);
  }
  h.start(aRun);
  await h.report(aRun, a.id, 'done');
  h.end(aRun);
  await wakes(h.T.id);
  assert.ok(h.store.getRequest(loan.requestId)?.loanEndedAt);
  assert.equal(h.store.readRequests().filter(row => row.taskId === h.T.id).length, 2);
  assert.equal(h.store.readReturns().filter(row => row.toTaskId === a.id && row.requestId).length, 3);
  const history = taskHistoryWindowSchema.parse(await (await commandFetch(
    new URL(`/api/task/history?task=${h.T.id}&mode=latest`, h.app.url))).json());
  assert.deepEqual(history.events.flatMap(event => event.loan ? [event.loan] : []), [
    { task: b.id, phase: 'ended' }, { task: b.id, phase: 'granted' },
  ]);
});

test('the parent can answer a borrower and lend in the same instruction', async t => {
  const { h, a, b, parent } = await setup(t);
  const initial = await request(h, a, parent.runId);
  h.start(initial.runId);
  const question = await h.ask(initial.runId, a.id, h.T.id);
  h.end(initial.runId);
  const loan = await request(h, a, parent.runId, b.id, question);
  assert.equal(h.store.getRequest(loan.requestId)?.answersQuestion, question);
  assert.equal(h.store.readReturns().filter(row => row.outcome === 'answer').length, 0);
  const history = (await h.current(a.id)).meta.log;
  assert.equal(history.find(row => row.kind === 'answered')?.questionId, question);
  h.start(loan.runId);
  await request(h, b, loan.runId);
});

for (const ending of ['stop', 'failure', 'move', 'stop the parent'] as const)
  test(`${ending} returns unprocessed borrowed work to the lender`, async t => {
    const { h, a, b, parent, pass, wakes } = await setup(t);
    const loan = await request(h, a, parent.runId, b.id);
    h.end(parent.runId);
    h.start(loan.runId);
    const verification = await request(h, b, loan.runId);
    h.start(verification.runId);
    if (ending !== 'stop') {
      await h.report(verification.runId, b.id, 'done');
      h.end(verification.runId);
    }
    if (ending === 'stop') {
      await h.personReport(a.id, 'stopped', 'Stop repair');
      assert.equal(h.store.get(verification.runId)?.stop_requested, false);
      assert.equal(h.store.getRequest(verification.requestId)?.returnTaskId, h.T.id);
      await h.report(verification.runId, b.id, 'done');
      h.end(verification.runId);
    } else if (ending === 'failure') {
      h.end(loan.runId, 'failed');
      await h.current(a.id);
    } else if (ending === 'move') {
      h.end(loan.runId);
      const queued = await wakes(a.id);
      await cli(h.root, 'task', 'move', '--task', a.id, '--parent', h.U.id,
        '--expected-task-hash', (await h.current(a.id)).hash);
      assert.equal(h.store.get(queued)?.state, 'cancelled');
    } else {
      h.end(loan.runId);
      await h.personReport(h.T.id, 'stopped', 'Stop the whole branch');
    }
    const before = h.store.readReturns().find(row => row.requestId === verification.requestId);
    assert.equal(before?.toTaskId, h.T.id);
    assert.equal(before?.outcome, 'succeeded');
    if (ending === 'stop the parent') {
      assert.deepEqual((await pass()).acceptedRequestIds, []);
      assert.equal(await h.current(b.id).then(task => task.meta.baseState), 'done');
      assert.ok((await h.current(b.id)).meta.log.find(row => row.id === before.causeLogId && row.description));
    } else {
      const dispatch = await pass();
      assert.ok(dispatch.acceptedRequestIds.some(id => h.store.getRequest(id)?.taskId === h.T.id));
      assert.ok(!dispatch.acceptedRequestIds.some(id => h.store.getRequest(id)?.taskId === a.id));
    }
  });

test('refuses user-owned grants, unrelated callers, and a waiting cycle at either entry', async t => {
  const { h, a, b, parent } = await setup(t);
  await assert.rejects(request(h, a, undefined, b.id), { code: 'forbidden' });
  const personWork = await request(h, b);
  h.start(personWork.runId);
  await assert.rejects(request(h, a, parent.runId, b.id), { code: 'forbidden' });
  await h.report(personWork.runId, b.id, 'done');
  h.end(personWork.runId);

  const loan = await request(h, a, parent.runId, b.id);
  h.start(loan.runId);
  const reverse = await request(h, b, parent.runId, a.id);
  await request(h, b, loan.runId);
  h.start(reverse.runId);
  await assert.rejects(request(h, a, reverse.runId), /wait for each other/);

  // A dependency on an unfinished task can create the same cycle before the target's first owner Run starts.
  const c = await sibling(h, 'Second verification');
  const newLoan = await request(h, a, parent.runId, c.id);
  assert.ok(newLoan.requestId);
  const cWork = await request(h, c, loan.runId);
  await assert.rejects(cli(h.root, 'dependency', 'set', '--task', c.id, '--after', a.id,
    '--expected-task-hash', (await h.current(c.id)).hash), /deadlock/);
  assert.equal(h.store.get(cWork.runId)?.state, 'queued');
  assert.equal(await userBall(h.root, a.id), null);
});

test('when a borrowed task moves and then fails, its current parent receives the failure', async t => {
  const { h, a, b, parent, pass } = await setup(t);
  const loan = await request(h, a, parent.runId, b.id);
  h.start(loan.runId);
  const work = await request(h, b, loan.runId);
  h.start(work.runId);
  await cli(h.root, 'task', 'move', '--task', b.id, '--parent', h.U.id,
    '--expected-task-hash', (await h.current(b.id)).hash);
  assert.equal(h.store.readReturns().find(row => row.requestId === work.requestId)?.outcome, 'moved');
  await assert.rejects(request(h, b, loan.runId), { code: 'forbidden' });
  h.end(work.runId, 'failed');
  const cause = [...(await h.current(b.id)).meta.log].reverse().find(row => row.toState === 'error');
  assert.ok(h.store.readReturns().some(row => row.causeLogId === cause?.id && row.toTaskId === h.U.id));
  assert.ok((await pass()).acceptedRequestIds.some(id => h.store.getRequest(id)?.taskId === h.U.id));
});

test('direct user work added after borrowing still leaves the failure with the user', async t => {
  const { h, a, b, parent, wakes } = await setup(t);
  const loan = await request(h, a, parent.runId, b.id);
  h.end(parent.runId);
  h.start(loan.runId);
  const work = await request(h, b, loan.runId);
  h.start(work.runId);
  h.end(loan.runId);
  await request(h, b);
  h.end(work.runId, 'failed');
  const next = await wakes(a.id);
  assert.equal(h.store.readReturns().find(row => row.requestId === work.requestId)?.outcome, 'failed');
  assert.ok(await userBall(h.root, b.id), 'the user keeps the decision on their failed work');
  h.start(next);
  await assert.rejects(request(h, b, next), { code: 'forbidden' });
});

test('holding and unholding a lent task notifies both the borrower and the parent', async t => {
  const { h, a, b, parent } = await setup(t);
  const loan = await request(h, a, parent.runId, b.id);
  const direct = await request(h, b, parent.runId);
  h.start(loan.runId);
  h.start(direct.runId);
  const borrowed = await request(h, b, loan.runId);
  for (const state of ['held', 'doing'] as const) {
    await h.personReport(b.id, state, 'Change verification hold');
    const change = (await h.current(b.id)).meta.log.at(-1)!;
    const rows = h.store.readReturns();
    assert.deepEqual(new Set(rows.filter(row => row.outcome === 'work_changed' && row.causeLogId === change.id)
      .map(row => row.toTaskId)), new Set([a.id, h.T.id]));
    assert.ok(!rows.some(row => row.requestId === borrowed.requestId || row.requestId === direct.requestId));
  }
});
