import type { ControlTreeDTO } from '@alpacawork/contract/control';
import { runRecordSchema } from '@alpacawork/contract/run';
import { ControlStore, touch, type ChangeKey } from '@alpacawork/db';
import { inertFixtureLaunch } from './agent-stub.ts';
import { record } from '../runs-fixtures.ts';

export type IndexAuthorities = Pick<ControlTreeDTO, 'tasks' | 'runs' | 'requests'>;

/** Seed authorities, rather than replacing a reader or injecting a derived screen. */
export function materializeIndexFacts(root: string, facts: IndexAuthorities): void {
  const store = new ControlStore(root);
  try { store.write(db => {
    const keys: ChangeKey[] = [];
    const remember = (kind: ChangeKey['kind'], table: string, column = 'id') => {
      for (const row of db.prepare(`SELECT ${column} AS id FROM ${table}`).all())
        keys.push({ kind, id: kind === 'run' ? `R${row.id}` : String(row.id) });
    };
    remember('task', 'tasks', 'external_id'); remember('log', 'task_log');
    remember('placement', 'placements'); remember('request', 'requests'); remember('run', 'runs');
    const identities = new Map(db.prepare('SELECT external_id,id FROM tasks').all()
      .map(row => [String(row.external_id), String(row.id)]));
    const logOwners = new Map(db.prepare('SELECT l.id,t.external_id FROM task_log l JOIN tasks t ON t.id=l.task_id').all()
      .map(row => [String(row.id), String(row.external_id)]));
    for (const task of facts.tasks) if (!identities.has(task.id)) identities.set(task.id, `index-fixture-${task.id}`);
    const byId = new Map(facts.tasks.map(task => [task.id, task]));
    const owningProject = (id: string): string => {
      const task = byId.get(id);
      if (!task) throw new Error(`Fixture Task is missing: ${id}`);
      if (task.kind === 'project') return task.id;
      if (!task.parentId) throw new Error(`Fixture Task has no project: ${id}`);
      return owningProject(task.parentId);
    };
    // Paging fixtures move historical timestamps and clone history. Restore the production guards in the same
    // transaction, so readers never see a schema without its immutable-history protection.
    const guards = db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN
      ('task_log_delete','log_texts_delete')`).all();
    for (const guard of guards) db.exec(`DROP TRIGGER ${guard.name}`);
    db.exec('PRAGMA defer_foreign_keys=ON');
    db.exec('DELETE FROM task_log_question; DELETE FROM log_texts; DELETE FROM task_stop_epochs; DELETE FROM task_log; DELETE FROM task_start_grants; DELETE FROM task_dialogues; DELETE FROM runs; DELETE FROM requests;');
    const inserted = new Set<string>();
    const putTask = (task: IndexAuthorities['tasks'][number]) => {
      if (inserted.has(task.id)) return;
      if (task.parentId && byId.has(task.parentId)) putTask(byId.get(task.parentId)!);
      const existing = db.prepare('SELECT revision FROM tasks WHERE external_id=?').get(task.id);
      const now = task.log.at(-1)?.at ?? '2026-01-01T00:00:00.000Z';
      const base = task.state === 'held' ? task.baseState : task.state;
      const values = [task.parentId ? identities.get(task.parentId)! : null, task.title, task.lifecycle,
        base, Number(task.state === 'held'), Number(task.userRequested),
        task.kind === 'project' ? JSON.stringify({ color: task.settings?.color ?? '#39659b' }) : null];
      if (existing) db.prepare(`UPDATE tasks SET parent_id=?,title=?,lifecycle=?,base_state=?,hold=?,user_requested=?,
        settings=?,revision=revision+1,updated_at=? WHERE external_id=?`).run(...values, now, task.id);
      else db.prepare(`INSERT INTO tasks(id,kind,number,project_task_id,parent_id,title,lifecycle,base_state,hold,
        user_requested,settings,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)`)
        .run(identities.get(task.id)!, task.kind, Number(task.id.slice(1)),
          task.kind === 'project' ? null : identities.get(owningProject(task.id))!, ...values, now, now);
      for (const row of db.prepare('SELECT field_id FROM task_values WHERE task_id=?').all(identities.get(task.id)!))
        keys.push({ kind: 'task_value', id: JSON.stringify([identities.get(task.id)!, row.field_id]) });
      db.prepare('DELETE FROM task_values WHERE task_id=?').run(identities.get(task.id)!);
      for (const [field, value] of Object.entries(task.values)) db.prepare('INSERT INTO task_values(task_id,field_id,value) VALUES(?,?,?)')
        .run(identities.get(task.id)!, field, JSON.stringify(value));
      for (const field of Object.keys(task.values))
        keys.push({ kind: 'task_value', id: JSON.stringify([identities.get(task.id)!, field]) });
      keys.push({ kind: 'task', id: task.id }); inserted.add(task.id);
    };
    for (const task of facts.tasks) putTask(task);
    for (const id of identities.keys()) if (!byId.has(id))
      db.prepare("UPDATE tasks SET lifecycle='deleted',revision=revision+1 WHERE external_id=?").run(id);
    const placementOwners = new Map(db.prepare('SELECT id,task_id FROM placements').all()
      .map(row => [String(row.id), String(row.task_id)]));
    const placement = (wanted: string, task: string, agent: string, at: string): string => {
      const id = placementOwners.has(wanted) && placementOwners.get(wanted) !== task ? `${wanted}-${task}` : wanted;
      if (!placementOwners.has(id)) {
        const person = `index-fixture-${id}`;
        db.prepare('INSERT OR IGNORE INTO agents(id,created_at) VALUES(?,?)').run(person, at);
        db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at)
          VALUES(?,?,?,?,0,1,?)`).run(id, task, person, agent, at);
        placementOwners.set(id, task);
      }
      keys.push({ kind: 'placement', id }); return id;
    };
    const requests = new Map<string, { task: string; placement: string }>();
    const putRequest = (id: string, task: string, seat: string, at: string,
      request?: IndexAuthorities['requests'][number]) => {
      if (requests.has(id)) return;
      if (request?.author.kind === 'placement') throw new Error('Index fixtures require a person-authored Request');
      db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,
        submitted_at,delivery_state,about_run_id,head_run_id) VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?)`)
        .run(id, task, seat, byId.get(task)!.hash, request?.mode ?? 'new', request?.body ?? 'Fixture execution',
          request?.purpose ?? 'instruction', JSON.stringify(request?.author ?? { kind: 'human' }), at,
          request?.deliveryState ?? 'recorded_unconfirmed', request?.aboutRunId ?? null, request?.aboutRunId ?? null);
      requests.set(id, { task, placement: seat }); keys.push({ kind: 'request', id });
    };
    for (const request of facts.requests) putRequest(request.id, request.taskId,
      placement(request.placementId, request.taskId, 'fake', request.submittedAt), request.submittedAt, request);
    for (const run of [...facts.runs].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))) {
      const seat = placement(run.placementId, run.taskId, run.agent, run.createdAt);
      const wanted = run.requestId ?? `index-fixture-${run.id}`;
      const held = requests.get(wanted);
      const request = held && (held.task !== run.taskId || held.placement !== seat
        || db.prepare('SELECT 1 FROM runs WHERE request_id=?').get(wanted)) ? `${wanted}-${run.id}` : wanted;
      putRequest(request, run.taskId, seat, run.createdAt);
      const persisted = runRecordSchema.parse(record(run.id, {
        task: run.taskId, placementId: seat, requestId: request, agent: run.agent, role: 'owner',
        launch: inertFixtureLaunch('codex', run.launchValues), usage: run.usage ? { conversation: null, ...run.usage } : null,
        caller: run.caller, resumes: run.resumes, continues: false, session: run.session,
        cwd: run.cwd, state: run.state, reason: run.reason, into: run.into,
        created_at: run.createdAt, started_at: run.startedAt, ended_at: run.endedAt,
      }));
      db.prepare('INSERT INTO runs(id,record,result_state) VALUES(?,?,?)').run(Number(run.id.slice(1)), JSON.stringify(persisted),
        ['succeeded', 'failed', 'cancelled', 'joined'].includes(run.state) ? 'missing' : 'pending');
      keys.push({ kind: 'run', id: run.id });
    }
    const claimedLogs = new Set<string>();
    for (const task of facts.tasks) {
      const names = new Map(task.log.map(entry => [entry.id, logOwners.has(entry.id) && logOwners.get(entry.id) !== task.id
        || claimedLogs.has(entry.id) ? `${task.id}:${entry.id}` : entry.id]));
      let ordinal = 0;
      for (const entry of task.log) {
        const id = names.get(entry.id)!; claimedLogs.add(id);
        if (entry.kind === 'request_accepted' || entry.kind === 'review_sent_back') {
          db.prepare('INSERT INTO task_log(id,task_id,ordinal,request_id) VALUES(?,?,?,?)')
            .run(entry.id, identities.get(task.id)!, ++ordinal, entry.id);
        } else {
          const { startsEstimateRound: _, ...stored } = entry;
          db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,?,?)')
            .run(id, identities.get(task.id)!, ++ordinal, JSON.stringify({ ...stored, id,
              ...('questionId' in stored ? { questionId: names.get(stored.questionId!) ?? stored.questionId } : {}),
              ...(stored.originCauseId ? { originCauseId: names.get(stored.originCauseId) ?? stored.originCauseId } : {}) }));
          if (stored.questionId) db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES(?,?)')
            .run(id, names.get(stored.questionId) ?? stored.questionId);
        }
        keys.push({ kind: 'log', id });
      }
    }
    for (const guard of guards) db.exec(String(guard.sql));
    db.prepare('UPDATE task_sequence SET next_number=max(next_number,?)').run(Math.max(...facts.tasks.map(task => Number(task.id.slice(1)))) + 1);
    db.prepare('UPDATE run_sequence SET next_number=max(next_number,?)').run(Math.max(0, ...facts.runs.map(run => Number(run.id.slice(1)))) + 1);
    for (const key of keys) touch(db, key);
  }); } finally { store.close(); }
}
