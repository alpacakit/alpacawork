import { expect, test } from 'vitest';
import { historyFixture } from './fixtures';
import { reportDisplay, reportEvent, type ReportEvent, type ReportNode } from '../src/domain/report-events';
import { questionReports } from '../src/domain/question-reports';
import { laneMarks } from '../src/features/tree/time-line';
import { eventKey } from '../src/domain/history';
import { timelineNoteOf } from '@alpacawork/contract/control';
import type { TaskHistory } from '../src/domain/time-history';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 12) + minute * 60_000).toISOString();
const make = (id: string, fields: Partial<ReportEvent> = {}): ReportEvent => ({
  key: `log:${fields.taskId ?? 'T1'}:${id}`, id, taskId: 'T1', at: at(1), kind: 'comment', text: id, description: id,
  mark: { kind: 'report', tone: 'quiet' }, author: { kind: 'owner', profileKey: 'codex' }, ...fields,
});
const roots = (records: ReportEvent[]) => reportDisplay(records).rows.map(row => row.key);
const nodeOf = (records: ReportEvent[], key: string): ReportNode => {
  const row = reportDisplay(records).rows.find(row => row.key === key)!;
  if (row.kind !== 'one') throw new Error('Expected a single report');
  return row.node;
};

test('a Run keeps its last report and every decision, with steps under the next decision of that same Run', () => {
  const records = [make('preparing', { wroteIn: 'R1' }), make('ask', { at: at(2), wroteIn: 'R1', kind: 'question' }),
    make('progress', { at: at(3), wroteIn: 'R1' }), make('review', { at: at(4), wroteIn: 'R1', kind: 'review' }),
    make('urgent', { at: at(5), wroteIn: 'R1', kind: 'urgent' }), make('done', { at: at(6), wroteIn: 'R1', kind: 'report' }),
    make('last', { at: at(7), wroteIn: 'R1' }), make('unrelated', { at: at(1.5), wroteIn: 'R2' }),
    make('unknown', { at: at(1.6) })];
  const display = reportDisplay(records);
  expect(roots(records)).toEqual(['log:T1:last', 'log:T1:done', 'log:T1:urgent', 'log:T1:review', 'log:T1:ask', 'log:T1:unknown', 'log:T1:unrelated']);
  expect(display.targets.get('log:T1:preparing')).toBe('log:T1:ask');
  expect(display.targets.get('log:T1:progress')).toBe('log:T1:review');
  expect(display.targets.get('log:T1:unrelated')).toBe('log:T1:unrelated');
  expect(nodeOf(records, 'log:T1:ask').chain.map(node => node.report.id)).toEqual(['preparing']);
  expect(records.every(report => !('chain' in report))).toBe(true);
});

test('many children join the recorded receiving Run; one child uses the first receiving Run with an action', () => {
  const records = [make('finalA', { wroteIn: 'R1', at: at(7) }), make('finalB', { wroteIn: 'R2', at: at(8) }),
    make('childA', { sourceTaskId: 'T2', taskId: 'T2', consumedBy: ['R0', 'R1', 'R2'], at: at(3) }),
    make('childB', { sourceTaskId: 'T3', taskId: 'T3', consumedBy: ['R1'], at: at(4) }),
    make('noConsumer', { sourceTaskId: 'T4', taskId: 'T4', at: at(5) }),
    make('noAction', { sourceTaskId: 'T5', taskId: 'T5', consumedBy: ['R0'], at: at(6) })];
  const display = reportDisplay(records);
  expect(display.targets.get('log:T2:childA')).toBe('log:T1:finalA');
  expect(display.targets.get('log:T3:childB')).toBe('log:T1:finalA');
  expect(nodeOf(records, 'log:T1:finalA').chain.map(node => node.report.id)).toEqual(['childA', 'childB']);
  expect(display.targets.get('log:T4:noConsumer')).toBe('log:T4:noConsumer');
  expect(display.targets.get('log:T5:noAction')).toBe('log:T5:noAction');
  const withoutDelivery = records.map(report => ({ ...report, consumedBy: [] }));
  expect(roots(withoutDelivery)).toContain('log:T2:childA');
});

test("the Task's own userQuestion and urgent child reports stay visible even when their Run delivered them", () => {
  const records = [make('final', { wroteIn: 'R1', at: at(9) }),
    make('question', { kind: 'question', wroteIn: 'R1', question: 'question', at: at(3) }),
    make('urgent', { kind: 'urgent', sourceTaskId: 'T3', taskId: 'T3', consumedBy: ['R1'], at: at(4) })];
  const projected = questionReports(records, { id: 'T1', state: 'doing', rowFacts: null, ball: { holder: 'user', reason: 'question', key: 'question', at: '2026-10-10T10:00:00Z', questionId: 'question', aboutRunId: null, count: null, code: null, failure: null }, userQuestions: [{ id: 'question', taskId: 'T1', taskTitle: 'Own',
    destination: { kind: 'user' }, applicable: true, state: 'open', askedAt: at(3), title: 'question', summary: '', decide: [{ decide_question: 'Choose' }] }] });
  const display = reportDisplay(projected);
  expect(display.targets.get('log:T1:question')).toBe('log:T1:question');
  expect(display.targets.get('log:T3:urgent')).toBe('log:T3:urgent');
  expect(projected.find(report => report.userQuestion)?.mark?.tone).toBe('turn');
});

test('question and answer use their reference; the source dialogue and relayed instructions are represented once', () => {
  const records = [make('q', { kind: 'question', at: at(1) }),
    make('a', { kind: 'answer', at: at(4), answers: 'q', message: 'message', mark: null, by: 'main' }),
    make('message', { kind: 'dialogue', at: at(3), mark: null }),
    make('instruction', { kind: 'request', at: at(5), message: 'message', mark: null, by: 'main' }),
    make('unpairedAnswer', { kind: 'answer', at: at(6), answers: 'not-loaded', mark: null })];
  const display = reportDisplay(records);
  expect(roots(records)).toEqual(['log:T1:unpairedAnswer', 'log:T1:q']);
  expect(['a', 'message', 'instruction'].map(id => display.targets.get(`log:T1:${id}`))).toEqual(Array(3).fill('log:T1:q'));
  const question = nodeOf(records, 'log:T1:q');
  expect(question.answer?.via?.relayed[0]?.report.id).toBe('instruction');
  expect(question.answer?.report.id).toBe('a');
  expect(roots(records.map(report => ({ ...report, answers: undefined })))).toContain('log:T1:a');
});

test('equal dialogue keys merge within ten minutes, retaining both answers and references', () => {
  const records = [make('new', { kind: 'dialogue', mark: null, wordsKey: 'same', at: at(9) }),
    make('old', { kind: 'dialogue', mark: null, wordsKey: 'same', at: at(1) }),
    make('outside', { kind: 'dialogue', mark: null, wordsKey: 'same', at: new Date(Date.parse(at(9)) - 10 * 60_000).toISOString() }),
    make('different', { kind: 'dialogue', mark: null, wordsKey: 'different', at: at(2) })];
  expect(roots(records)).toEqual(['log:T1:new', 'log:T1:different', 'log:T1:outside']);
  expect(nodeOf(records, 'log:T1:new').earlier[0]?.report.id).toBe('old');
});

test('the three row types keep member work subordinate and keep the latest member result when no owner report follows it', () => {
  const member = (id: string, minute: number) => make(id, { at: at(minute), author: { kind: 'member', profileKey: 'codex' } });
  const records = [member('newMember', 9), member('otherMember', 8), make('owner', { at: at(7) }), member('nested', 6),
    make('instruction', { at: at(5), mark: null, kind: 'request', by: 'main' }), member('single', 4)];
  const display = reportDisplay(records);
  expect(display.rows.map(row => row.kind === 'inner' ? 'inner' : row.node.tier)).toEqual(['inner', 'story', 'line', 'inner']);
  expect(display.targets.get('log:T1:nested')).toBe('log:T1:owner');
  expect(display.targets.get('log:T1:newMember')).toBe('inner:log:T1:newMember');
});


test('History and the time line consume the same causal/pairing rules without changing compact glyphs', () => {
  const events = historyFixture([
    { id: 'step', kind: 'comment', at: at(1), title: 'Preparing', runId: 'R1', author: { kind: 'owner', profileKey: 'codex' } },
    { id: 'ask', kind: 'question', at: at(3), title: 'Choose', open: true, userQuestion: true, runId: 'R1', askedTo: 'user', author: { kind: 'owner', profileKey: 'codex' } },
    { id: 'child', kind: 'report', at: at(2), taskId: 'T2', fromChild: true, consumedBy: ['R1'], title: 'Done', author: { kind: 'owner', profileKey: 'claude' } },
  ]);
  const reports = events.map(event => ({ ...reportEvent(event, id => id === 'T1' ? 'ask' : null), userQuestion: event.id === 'ask' }));
  const display = reportDisplay(reports);
  const history = (id: string): TaskHistory => ({ taskId: id, start: Date.parse(at(0)), end: null, segments: [],
    events: events.filter(event => event.taskId === id).map(event => ({ key: eventKey(event), at: Date.parse(event.at),
      source: { note: { ...timelineNoteOf(event), displayed: display.targets.get(eventKey(event)) === eventKey(event) }, yours: event.id === 'ask' } })) });
  const line = laneMarks(history('T1'));
  const shown = [...display.targets].filter(([key, target]) => key === target && key.startsWith('log:T1:')).map(([key]) => key);
  expect(line.map(mark => mark.event.key)).toEqual(shown);
  expect(line[0]?.display).toBe('pin');
  expect(line[0]?.event.source.note?.mark?.kind).toBe('report');
  expect(laneMarks(history('T1')).map(mark => mark.event.key)).toEqual(['log:T1:ask']);
});


test('scope invalidation remains an independent reason row even beside member work and a consuming owner action', () => {
  const end = make('Rend', { kind: 'run_end', text: 'scope_invalidated', mark: null });
  const display = reportDisplay([make('action', { wroteIn: 'R1' }), end,
    { ...end, key: 'run:Rchild:finished', id: 'Rchild', taskId: 'T2', sourceTaskId: 'T2', consumedBy: ['R1'] }]);
  expect(display.rows.map(row => row.kind === 'one' ? [row.node.report.id, row.node.tier] : ['inner'])).toEqual([
    ['Rchild', 'line'], ['action', 'story'], ['Rend', 'line'],
  ]);
});

test('a record that only closes a wait is no row; the newer record that closed a wait still is one', () => {
  const question = make('ask', { kind: 'question', mark: { kind: 'report', tone: 'quiet' }, released: 'withdrawn' });
  for (const kind of ['withdrawn', 'expired'] as const) {
    const closing = make('closing', { at: at(2), kind, text: '', description: null, mark: null });
    const newer = make('again', { at: at(2), kind: 'question', wroteIn: 'R2' });
    expect(roots([question, closing, newer])).toEqual(['log:T1:again', 'log:T1:ask']);
  }
  const review = make('review', { kind: 'review', released: 'invalidated' });
  const instruction = make('send', { at: at(2), kind: 'request', mark: null, by: 'human', author: { kind: 'human' } });
  expect(roots([review, instruction])).toEqual(['log:T1:send', 'log:T1:review']);
});
