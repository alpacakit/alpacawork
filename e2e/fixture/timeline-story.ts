import { inertFixtureLaunch } from '../../tests/helpers/agent-stub.ts';
/** Synthetic question-timeline shapes. Every saved Run and configured agent is inert. */
import { ControlStore, taskHash } from '@alpacawork/db';
import { record } from '../../tests/runs-fixtures.ts';
import { patchTask, seedReview } from './task-state.ts';

export const STORY = { single: 'T113', parent: 'T11', child: 'T114', grandchild: 'T1142',
  singleQuestion: 'L-story-single', ownQuestion: 'L-story-own', secondQuestion: 'L-story-second', deepQuestion: 'L-story-deep',
  childQuestion: 'L-story-child', grandQuestion: 'L-story-grand', childStatus: 'L-story-child-status', review: 'T115', statusTask: 'T118', action: 'L-story-own', step: 'L-story-step' } as const;
const at = (minute: number) => new Date(Date.UTC(2026, 8, 25, 1, minute)).toISOString();
/** What a story's question asks, as its asking record fixes it. */
const asking = (title: string) => [{ decide_kind: 'choose', decide_question: title, decide_choices: [
  { decide_choice: 'A Option A', decide_choice_detail: 'Proceed with A.' }, { decide_choice: 'B Option B', decide_choice_detail: 'Proceed with B.' }] }];

export function seedTimelineStories(root: string) {
  const store = new ControlStore(root, { busyTimeoutMs: 1000 });
  try {
    store.write(db => {
      // A separate top-level leaf gives the single-question case its own display location.
      db.prepare('UPDATE tasks SET parent_id=(SELECT id FROM tasks WHERE external_id=?) WHERE external_id=?').run('P1', STORY.single);
      const owner = (taskId: string) => String(db.prepare('SELECT id FROM placements WHERE task_id=? AND responsible=1 AND ended_at IS NULL').get(taskId)!.id);
      const actor = (taskId: string) => ({ kind: 'placement', placementId: owner(taskId) });
      const request = (taskId: string, id: string, minute: number) => {
        const task = db.prepare('SELECT id,revision FROM tasks WHERE external_id=?').get(taskId)!;
        db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state)
          VALUES(?,?,?,?,?,'new',?,'instruction',?,?, 'recorded_unconfirmed')`)
          .run(id, taskId, owner(taskId), 1, taskHash(String(task.id), Number(task.revision)), 'Read the received records',
            JSON.stringify({ kind: 'human' }), at(minute));
      };
      const run = (id: number, task: string, requestId: string, minute: number) => {
        const saved = record(`R${id}`, { task, placementId: owner(task), requestId, agent: 'codex', cwd: root,
          launch: inertFixtureLaunch('codex'),
          state: 'succeeded', created_at: at(minute), started_at: at(minute), ended_at: at(minute + 3), exit: { code: 0, signal: null } });
        db.prepare('INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,?,? ,\'present\')')
          .run(id, JSON.stringify(saved), 'Synthetic received records', 'Fixture result');
      };
      request(STORY.parent, 'Q-story-parent', 4);
      request(STORY.child, 'Q-story-child', 2);
      run(100, STORY.parent, 'Q-story-parent', 4);
      run(101, STORY.child, 'Q-story-child', 2);
      request(STORY.parent, 'Q-story-parent2', 10);
      run(102, STORY.parent, 'Q-story-parent2', 10);
      const common = (id: string, minute: number, task: string) => ({ id, at: at(minute), actor: actor(task), fromState: null, toState: null });
      const ask = (task: string, id: string, title: string, minute: number, to: string | null, runId?: string) => {
        const entry = { ...common(id, minute, task), kind: 'asked', title, description: `Please choose. ${title}`, askedTo: to, decide: asking(title), ...(runId ? { runId } : {}) };
        patchTask(root, task, { logs: [entry] });
      };
      ask(STORY.single, STORY.singleQuestion, 'Choose the release approach', 1, null);
      ask(STORY.grandchild, STORY.grandQuestion, 'Grandchild number: 1 or 2', 1, STORY.child);
      patchTask(root, STORY.child, { state: 'doing' });
      ask(STORY.child, STORY.childQuestion, 'Relay the grandchild number', 3, STORY.parent, 'R101');
      patchTask(root, STORY.parent, { logs: [{ ...common(STORY.step, 4, STORY.parent), kind: 'reported', title: 'Preparing the number question', description: 'This belongs to R100 only.', runId: 'R100' }] });
      ask(STORY.parent, STORY.ownQuestion, 'Choose the grandchild number', 5, null, 'R100');
      patchTask(root, STORY.parent, { logs: [{ ...common('L-story-own-withdrawn', 10, STORY.parent), kind: 'question_withdrawn', title: null, description: null, questionId: STORY.ownQuestion }] });
      ask(STORY.parent, STORY.secondQuestion, 'Choose an animal', 11, null, 'R102');
      patchTask(root, STORY.grandchild, { logs: [{ ...common('L-story-grand-withdrawn', 11, STORY.grandchild), kind: 'question_withdrawn', title: null, description: null, questionId: STORY.grandQuestion }] });
      ask(STORY.grandchild, STORY.deepQuestion, 'Choose the deep child colour', 12, null);
      // Human questions stay on their own Task, regardless of the user-requested mark.
      patchTask(root, STORY.grandchild, { state: 'doing', userRequested: false });
      patchTask(root, STORY.statusTask, { state: 'done', logs: [{ ...common(STORY.childStatus, 15, STORY.statusTask), kind: 'reported', title: 'Child progress remains visible', description: 'Finished the independent child work', fromState: 'doing', toState: 'done' }] });
      const deliver = (id: string, log: string, task: string, requestId: string, minute: number) => {
        db.prepare('INSERT INTO returns(id,to_task_id,outcome,cause_log_id,created_at) VALUES(?,?,\'question\',?,?)').run(id, task, log, at(minute));
        db.prepare('INSERT INTO return_deliveries(return_id,wake_request_id,reserved_at,received_at,consumed_at) VALUES(?,?,?,?,?)')
          .run(id, requestId, at(minute), at(minute), at(minute + 2));
      };
      deliver('RET-story-grand', STORY.grandQuestion, STORY.child, 'Q-story-child', 2);
      deliver('RET-story-child', STORY.childQuestion, STORY.parent, 'Q-story-parent', 4);
      // A second child record reaches the same Run: many-to-one, without a title/time heuristic.
      ask('T112', 'L-story-child2', 'A second child asks its parent', 3, STORY.parent);
      deliver('RET-story-child2', 'L-story-child2', STORY.parent, 'Q-story-parent', 4);
      // Real older questions also have history before them. Keep enough older, unrelated records to distinguish
      // top alignment from native end-of-scroll clamping without adding artificial product whitespace.
      for (const task of [STORY.single, STORY.parent, STORY.grandchild]) patchTask(root, task, { logs: Array.from({ length: 35 }, (_, n) => ({
        id: `L-story-prior-${task}-${n}`, kind: 'reported', at: at(-40 + n), actor: { kind: 'human' }, fromState: null, toState: null,
        title: `Prior instruction ${n}`, description: `Earlier independent record ${n}.` })) });
      // Enough independent notes to keep the target and its causal source outside the first History page.
      for (const task of [STORY.single, STORY.parent, STORY.grandchild]) patchTask(root, task, { logs: Array.from({ length: 90 }, (_, n) => ({
        id: `L-story-page-${task}-${n}`, kind: 'reported', at: at(20 + n / 100), actor: { kind: 'human' }, fromState: null, toState: null,
        title: `Independent note ${n}`, description: `Unrelated record ${n}.` })) });
      db.prepare('UPDATE run_sequence SET next_number=103 WHERE singleton=1').run();
    });
  } finally { store.close(); }
  seedReview(root, STORY.review, { title: 'Child result awaiting confirmation' });
}
