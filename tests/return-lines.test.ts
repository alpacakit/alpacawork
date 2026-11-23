/** The lines a seat is woken with: drawn in full while they fit, else as the command that reads what they leave out. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETURN_CLOSURES, RETURN_NOTICES } from '@alpacawork/contract';
import { MAX_INSTRUCTION_BYTES } from '@alpacawork/raw';
import type { StoredRequest, StoredReturn } from '@alpacawork/runs';
import { openWorkLines, outcomeWords, returnLines, type ReturnLine } from '@alpacawork/backend/test-dist/control/return-lines.js';

const time = '2026-01-01T00:00:00Z';
type ClosureLine = Extract<ReturnLine, { outcome: typeof RETURN_CLOSURES[number] }>;

const sent = (id: string, taskId: string, placementId: string, body: string): StoredRequest => ({ id, taskId, placementId,
  placementRevision: 1, taskHash: 'a'.repeat(64), waitCycleId: 'C1', headRunId: null, aboutRunId: null, mode: 'new', body,
  purpose: 'instruction', author: { kind: 'placement', placementId: 'P2' }, submittedAt: time, deliveryState: 'queued',
  runId: null });
const waiting = (id: string): StoredReturn => ({ id, requestId: null, outcome: 'question', toTaskId: 'T2',
  boundaryRunId: null, causeLogId: `L-${id}`, holdReason: null, holdProblemReason: null, createdAt: time, deliveries: [], resolution: null });
const closing = (id: string, body = `Inspect part ${id}`): ClosureLine => ({ id, outcome: 'succeeded',
  request: { id: `ask-${id}`, body }, from: { by: 'child', taskId: 'T3', reason: null } });
const question = (text: string): ReturnLine => ({ id: 'RETq', outcome: 'question', taskId: 'T3', questionId: 'L-ask',
  title: 'Which layout?', text });
const answer = (text: string): ReturnLine => ({ id: 'RETa', outcome: 'answer', taskId: 'T2', questionId: 'L-ask', text });
const handover = (): ReturnLine => ({ id: 'RETh', outcome: 'handover', taskId: 'T2', state: 'doing' });
/** A text past the wake's budget: an answer's fixed text may be up to 1 MiB (log_texts). */
const long = 'あ'.repeat(Math.ceil(MAX_INSTRUCTION_BYTES / 3) + 1);
const bytes = (text: string) => Buffer.byteLength(text);

test('a question goes with its full text and how to answer it, and with the command reading the text once it does not fit', () => {
  const answerWith = 'alpacawork task request --task T3 --answers L-ask --instruction-file -';
  const full = returnLines([question('Pick A or B.\nA keeps the sidebar.')], MAX_INSTRUCTION_BYTES);
  assert.deepEqual(full.ids, ['RETq']);
  assert.ok(full.body.includes('"Which layout?":\nPick A or B.\nA keeps the sidebar.\n'), full.body);
  assert.ok(full.body.includes(answerWith), full.body);
  assert.doesNotMatch(full.body, /--question/);
  const cut = returnLines([question(long)], MAX_INSTRUCTION_BYTES);
  assert.deepEqual(cut.ids, ['RETq'], 'the question is delivered, its text read by the command');
  assert.ok(bytes(cut.body) <= MAX_INSTRUCTION_BYTES);
  assert.ok(!cut.body.includes(long.slice(0, 100)));
  assert.ok(cut.body.includes('full text: alpacawork task get --task T3 --question L-ask'), cut.body);
  assert.ok(cut.body.includes(answerWith), 'how to answer stays in the shorter form');
});

test('an answer goes with its fixed text and the command reading its question, and with the command alone once it does not fit', () => {
  const read = 'alpacawork task get --task T2 --question L-ask';
  const full = returnLines([answer('Take A.')], MAX_INSTRUCTION_BYTES);
  assert.ok(full.body.includes(':\nTake A.\n'), full.body);
  assert.ok(full.body.includes(`Full text of the question: ${read}`), full.body);
  const cut = returnLines([answer(long)], MAX_INSTRUCTION_BYTES);
  assert.deepEqual(cut.ids, ['RETa']);
  assert.ok(bytes(cut.body) <= MAX_INSTRUCTION_BYTES);
  assert.ok(!cut.body.includes(long.slice(0, 100)));
  assert.ok(cut.body.includes(`full text: ${read}`), cut.body);
});

test('a handover carries state and retrieval commands; the common open-work drawer owns the list', () => {
  const notice = returnLines([handover()], MAX_INSTRUCTION_BYTES);
  assert.deepEqual(notice.ids, ['RETh']);
  assert.match(notice.body, /Current state: doing/);
  assert.ok(notice.body.includes('alpacawork task get --task T2 --include openObligations'));
  assert.ok(notice.body.includes('alpacawork task get --task T2 --include closedQuestions, '));
  assert.ok(notice.body.includes('alpacawork task returns --task T2'));
  assert.doesNotMatch(notice.body, /Open requests|[Rr]eturns and notices not yet handled/);
  const requests = [sent('work', 'T2', 'W1', 'Fix the build\nwith the new flags'), sent('ask', 'T3', 'P3', 'Write the docs')];
  requests[1]!.runId = 'R7';
  const { full, short } = openWorkLines('T2', { requests, returns: [waiting('RET1'), waiting('RET2')] });
  assert.match(full, /Open requests: 2\n- Member W1 \(request work "Fix the build"\)\n- Child task T3 \(request ask "Write the docs", Run R7\)\n/);
  assert.match(full, /Returns and notices not yet handled: 2 — alpacawork task returns --task T2\n/);
  assert.ok(full.endsWith('Request texts, recipients and Runs: alpacawork task get --task T2 --include openObligations'));
  assert.match(short, /Open requests: 2; returns and notices not yet handled: 2\. Too large to include/);
  assert.ok(short.includes('alpacawork task get --task T2 --include openObligations'));
  assert.doesNotMatch(short, /Write the docs|Fix the build/);
  const empty = openWorkLines('T2', { requests: [], returns: [] }).full;
  assert.match(empty, /^No open requests\./);
  assert.doesNotMatch(empty, /task returns/, 'nothing left undelivered names no command for it');
  assert.ok(empty.includes('--include', 'openObligations'), 'the empty list still has its authoritative read command');
});

test("a worker's end and a child's are told in their own words, with the command that reads each", () => {
  const byWorker = (line: ClosureLine, runId: string | null = 'R4'): ClosureLine =>
    ({ ...line, from: { by: 'worker', placementId: 'W1', runId } });
  for (const outcome of RETURN_CLOSURES) {
    const child = { ...closing('RET1'), outcome };
    assert.ok(outcomeWords(child) && outcomeWords(byWorker(child)), outcome);
  }
  assert.notEqual(outcomeWords(closing('RET1')), outcomeWords(byWorker(closing('RET1'))), 'a worker succeeds, a child completes');
  const worker = returnLines([byWorker(closing('RET1'))], 4096).body;
  assert.match(worker, /Member W1: .* \(request "Inspect part RET1"\) — alpacawork run get --run R4$/);
  const unread = returnLines([byWorker({ ...closing('RET1'), outcome: 'failed' }, null)], 4096).body;
  assert.doesNotMatch(unread, /run get/, 'a worker Request closed without a Run names none');
  const reason = `Build failed\n${'x'.repeat(300)}`;
  const failed = returnLines([{ ...closing('RET1'), outcome: 'failed', from: { by: 'child', taskId: 'T3', reason } }], 4096).body;
  assert.ok(failed.includes(` (cause: Build failed ${'x'.repeat(200 - 'Build failed '.length)}…)`), failed);
  assert.match(failed, / — alpacawork task get --task T3$/);
});

test('each notice is told by its kind, with the command that reads it', () => {
  const notices: ReturnLine[] = [question('Pick one.'), { id: 'RETu', outcome: 'urgent', taskId: 'T3', reason: 'The deploy broke' },
    answer('Take A.'), handover(), { id: 'RETc', outcome: 'child_added', taskId: 'T4', title: 'Draft the notes' }, { id: 'RETchanged', outcome: 'work_changed', taskId: 'T5', causeId: 'L-CHANGED' }];
  assert.deepEqual(notices.map(line => line.outcome), [...RETURN_NOTICES]);
  assert.equal(new Set(notices.map(outcomeWords)).size, RETURN_NOTICES.length);
  const body = returnLines(notices, MAX_INSTRUCTION_BYTES).body;
  assert.match(body, /The deploy broke — alpacawork task get --task T3 --log 5\n/);
  assert.doesNotMatch(body, /user(?:'s)? request/i);
  assert.match(body, /T4 "Draft the notes".* — alpacawork task get --task T4\n/);
  assert.match(body, /work changed \(cause L-CHANGED\) — alpacawork task get --task T5 --log 5$/);
});

test('return lines stop at the byte limit and name how many are left and where they are read', () => {
  const rows = Array.from({ length: 10 }, (_, index) => closing(`RET${index}`));
  const full = returnLines(rows, 10_000);
  assert.deepEqual(full.ids, rows.map(row => row.id));
  assert.doesNotMatch(full.body, /more do not fit here/);
  const budget = Math.floor(bytes(full.body) * 0.7);
  const limited = returnLines(rows, budget);
  assert.ok(limited.ids.length > 0 && limited.ids.length < rows.length, String(limited.ids.length));
  assert.ok(bytes(limited.body) <= budget);
  assert.match(limited.body, new RegExp(`\\n${rows.length - limited.ids.length} more do not fit here.*alpacawork task returns --task`));
});

test('seven hundred returns are delivered in bounded batches without losing a row', () => {
  const rows = Array.from({ length: 700 }, (_, index) => closing(`RET${index}`, `Inspect part ${index} of the long list`));
  const delivered = new Set<string>();
  for (let batch = 0; delivered.size < rows.length; batch++) {
    const remaining = rows.filter(row => !delivered.has(row.id));
    const result = returnLines(remaining, 4096);
    assert.ok(result.ids.length > 0, 'every batch makes progress');
    assert.ok(bytes(result.body) <= 4096);
    assert.deepEqual(result.ids, remaining.slice(0, result.ids.length).map(row => row.id), 'in the order given');
    if (result.ids.length < remaining.length)
      assert.match(result.body, new RegExp(`\\n${remaining.length - result.ids.length} more do not fit here`));
    for (const id of result.ids) delivered.add(id);
    assert.ok(batch < 100, 'all rows must make progress');
  }
  assert.equal(delivered.size, 700);
});
