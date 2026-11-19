/** Canonical, immutable askedTo and decide from INSERT; closings append facts, never UPDATE a question. */
import { ControlStore, touch } from '@alpacawork/db';
import { randomUUID } from 'node:crypto';
import { initialControlDocument } from '@alpacawork/raw';
import { taskLogSchema } from '@alpacawork/contract/control';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';

export function questionFact(root: string, task: string, id: string,
  fact: { askedTo: string | null } | { closes: string } | { expires: true } = { askedTo: null }) {
  const store = new ControlStore(root, { busyTimeoutMs: 1000 });
  try { store.write(db => {
    const row = db.prepare('SELECT id FROM tasks WHERE external_id=?').get(task)!;
    const ordinal = Number(db.prepare('SELECT COALESCE(MAX(ordinal),-1)+1 AS n FROM task_log WHERE task_id=?').get(String(row.id))!.n);
    let actor: { kind: 'human' } | { kind: 'placement'; placementId: string } = { kind: 'human' };
    if ('askedTo' in fact) {
      const existing = db.prepare('SELECT id FROM placements WHERE task_id=? AND ended_at IS NULL AND responsible=1').get(task);
      if (existing) actor = { kind: 'placement', placementId: String(existing.id) };
      else {
      const agent = randomUUID(), placementId = randomUUID(), at = new Date().toISOString();
      db.prepare('INSERT INTO agents(id,created_at) VALUES (?,?)').run(agent, at);
      db.prepare('INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at) VALUES (?,?,?,?,1,1,?)').run(placementId, task, agent, 'fake', at);
      actor = { kind: 'placement', placementId };
      }
    }
    const entry = taskLogSchema.parse({ id, at: new Date().toISOString(), title: 'Choose', description: 'Canonical question fixture',
      actor, fromState: null, toState: null,
      ...('askedTo' in fact ? { kind: 'asked', askedTo: fact.askedTo,
        decide: [{ decide_question: 'Proceed?', decide_choices: [{ decide_choice: 'Yes', decide_choice_detail: 'Proceed' }] }] } : 'closes' in fact
        ? { kind: 'question_withdrawn', questionId: fact.closes } : { kind: 'reported', toState: 'stopped' }) });
    db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)').run(id, String(row.id), ordinal, JSON.stringify(entry));
    touch(db, { kind: 'log', id });
    touch(db, { kind: 'task', id: task });
    if ('closes' in fact) db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES (?,?)').run(id, fact.closes);
  }); } finally { store.close(); }
}
export function messageTarget(root: string, parentId: string, state: 'doing' | 'done' = 'doing') {
  const store = new ControlStore(root, { busyTimeoutMs: 1000 });
  try { return store.write(db => new TaskRepository(root, db).create('task', id => ({ values: { notes: 'Recipient' },
    meta: { ...initialControlDocument(id, parentId, 'Explicit recipient', { kind: 'task', userRequested: true, actor: { kind: 'human' } }), baseState: state, state } })));
  } finally { store.close(); }
}
