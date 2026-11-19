/** Deterministic synthetic database mutations shared by projection and routing replays.
 * Explicit change keys are inputs here; transaction touch completeness belongs to its separate guard. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { isRunEnded } from '@alpacawork/contract/run';
import { launchSchema } from '@alpacawork/contract/run-protocol';
import { openQuestions } from '@alpacawork/raw';
import { DEFAULT_SCHEMA } from '@alpacawork/contract';
import { coordinatorRecord } from '../../runs-fixtures.ts';
import type { ControlStore, ChangeKey } from '@alpacawork/db';
import type { RunId } from '@alpacawork/contract';
import type { ControlRunDTO } from '@alpacawork/contract/control';
import type { RecordsReader, TaskBundle } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';
import type { Operation } from './harness.ts';
export interface MutationState {
  externalFiles: Map<string, TaskBundle['files']>;
  causes: Map<RunId, ControlRunDTO['errorCause']>;
  lowAutomaticLimit: boolean;
  fresh: boolean;
}
export const mutationState = (): MutationState => ({ externalFiles: new Map(), causes: new Map(), lowAutomaticLimit: false, fresh: false });
export function mutate(store: ControlStore, before: RecordsReader, operation: Operation, state: MutationState) {
  const bundles = [...before.taskIds()].map(id => before.bundle(id)!);
  const workspaceId = store.read(db => db.prepare('SELECT id FROM workspace_identity WHERE singleton=1').get()!.id);
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const attemptRecord = (run: TaskBundle['runs'][number], attemptId: string) => JSON.stringify(launchSchema.parse({
    protocol: 1, workspaceId, runId: run.id, attemptId, cwd: store.root,
    invocation: { launch: run.launch, mode: 'start', session: null }, prompt: 'Synthetic attempt',
    initialInputId: uuid(Number(run.id.slice(1)) + 100000), format: 'a'.repeat(64), runMinutes: 10,
    commandSeconds: null, credential: 'a'.repeat(64), entry: process.execPath, version: 'synthetic',
    server: null, ancestors: [], release: null,
  }));
  const raw = (run: TaskBundle['runs'][number]) => { const { resultHead: _head, ...record } = run as TaskBundle['runs'][number] & { resultHead?: string }; return record; };
  const keys: ChangeKey[] = [], id = `T${operation.target}`, own = before.bundle(id)!;
  const at = new Date(Date.parse('2026-11-16T00:00:00Z') + operation.step * 1000).toISOString();
  const ownRun = raw(own.runs[0] ?? bundles.flatMap(b => b.runs)[operation.variant % 7]!);
  const runOwner = ownRun.task!;
  const taskKey = () => { keys.push({ kind: 'task', id }); };
  const log = (kind: string, fields: Record<string, unknown>, taskId = id) => {
    const logId = `replay-log-${operation.step}`;
    store.write(db => db.prepare(`INSERT INTO task_log(id,task_id,ordinal,entry)
      SELECT ?,id,(SELECT coalesce(max(ordinal),-1)+1 FROM task_log WHERE task_id=tasks.id),? FROM tasks WHERE external_id=?`).run(logId,
      JSON.stringify({ id: logId, kind, at, title: 'Synthetic replay record', description: 'Fictional replay.', actor: { kind: 'human' }, fromState: null, toState: null, ...fields }), taskId));
    keys.push({ kind: 'log', id: logId });
  };
  const runPatch = (patch: Record<string, unknown>) => {
    store.write(db => db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify({ ...ownRun, ...patch }), Number(ownRun.id.slice(1))));
    keys.push({ kind: 'run', id: ownRun.id });
  };
  /** A new execution is a new Request and Run; terminal executions are never restarted in place. */
  const execution = (no: number, status: 'running' | 'succeeded' | 'failed' | 'needs_review') => {
    const available = [own, ...bundles.filter(bundle => bundle !== own)].find(bundle => bundle.task.meta.lifecycle === 'active'
      && !['done', 'stopped', 'waiting'].includes(bundle.task.meta.baseState)
      && before.ancestors(bundle.task.id).every(id => { const task = before.bundle(id)!.task; return task.meta.lifecycle === 'active' && !['done', 'stopped'].includes(task.meta.baseState); })
      && bundle.placements.some(p => p.active && !bundle.runs.some(run => run.placementId === p.id && !isRunEnded(run.state))));
    if (!available) return undefined;
    const placement = available.placements.find(p => p.active && !available.runs.some(run => run.placementId === p.id && !isRunEnded(run.state)))!;
    const requestId = `synthetic-execution-${operation.step}-${no}`;
    const run = { ...ownRun, id: `R${no}`, task: available.task.id, placementId: placement.id, requestId,
      role: placement.responsible ? 'owner' as const : 'worker' as const, caller: null, resumes: null, continues: false,
      state: status, reason: status === 'failed' ? 'exit' as const : null, into: null, session: null, usage: null,
      stop_requested: false, pids: { manager: null, agent: null }, created_at: at, started_at: at,
      ended_at: status === 'running' ? null : at, exit: status === 'running' ? null : { code: status === 'failed' ? 1 : 0, signal: null } };
    store.write(db => {
      db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state)
        VALUES(?,?,?,?,?,'new','Synthetic execution','instruction','{"kind":"human"}',?,'queued')`)
        .run(requestId, available.task.id, placement.id, placement.revision, available.task.hash, at);
      db.prepare('INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,?,?,?)').run(no, JSON.stringify(run), 'Synthetic execution prompt',
        status === 'running' ? null : 'Synthetic execution result', status === 'running' ? 'pending' : 'present');
    });
    keys.push({ kind: 'request', id: requestId }, { kind: 'run', id: run.id });
    return run;
  };
  switch (operation.kind) {
    case 'create': {
      const uuid = `synthetic-task-${operation.step}`, createdId = `T${10000 + operation.step}`, logId = `synthetic-created-${operation.step}`;
      store.write(db => {
        db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,revision,created_at,updated_at)
          SELECT ?,'task',?,id,id,?,'active','todo',0,0,1,?,? FROM tasks WHERE external_id='P1'`).run(uuid, 10000 + operation.step, 'Synthetic created task', at, at);
        db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,0,?)').run(logId, uuid, JSON.stringify({ id: logId, kind: 'created', at,
          title: 'Synthetic task created', description: null, actor: { kind: 'human' }, fromState: null, toState: 'todo', userRequested: false }));
      });
      keys.push({ kind: 'task', id: createdId }); break;
    }
    case 'title': store.write(db => db.prepare('UPDATE tasks SET title=?,revision=revision+1 WHERE external_id=?').run(`Synthetic replay ${operation.step}`, id)); taskKey(); break;
    case 'values': store.write(db => db.prepare("UPDATE task_values SET value=? WHERE task_id=(SELECT id FROM tasks WHERE external_id=?) AND field_id='goal'").run(JSON.stringify(`Replay goal ${operation.step}`), id)); keys.push({ kind: 'task_value', id }); break;
    case 'state': {
      const state = ['todo', 'doing', 'done', 'stopped'][operation.variant % 4]!;
      if (['done', 'stopped'].includes(state) && [...before.subtree(id)].some(child => { const bundle = before.bundle(child)!;
        return bundle.runs.some(run => !isRunEnded(run.state)) || child !== id && bundle.task.meta.lifecycle === 'active' && !['done', 'stopped'].includes(bundle.task.meta.baseState); })) break;
      store.write(db => db.prepare('UPDATE tasks SET base_state=?,hold=?,revision=revision+1 WHERE external_id=?').run(state, state === 'done' || state === 'stopped' ? 0 : operation.variant % 2, id)); taskKey(); break;
    }
    case 'question': {
      const placement = own.placements.find(p => p.active);
      if (!placement || own.task.meta.lifecycle !== 'active' || own.task.meta.baseState === 'waiting' || openQuestions(own.task.meta.log).length) break;
      log('asked', { title: `Synthetic question ${operation.step}`, askedTo: null, decide: [{ question: 'Synthetic choice', choices: ['Continue', 'Wait'] }], actor: { kind: 'placement', placementId: placement.id } }); break;
    }
    case 'answer': {
      const question = openQuestions(own.task.meta.log)[0];
      if (question) log('question_withdrawn', { questionId: question.id }); break;
    }
    case 'request': {
      const request = own.requests[0] ?? bundles.flatMap(b => b.requests)[0]!; const owner = request.taskId!;
      const requestId = `synthetic-request-${operation.step}`;
      store.write(db => {
        let cycle: string | null = null;
        if (operation.variant % 2 === 0) {
          const open = db.prepare("SELECT id FROM wait_cycles WHERE task_id='T2' AND closed_at IS NULL").get();
          cycle = open ? String(open.id) : `synthetic-instruction-cycle-${operation.step}`;
          if (!open) {
            db.prepare("INSERT INTO wait_cycles(id,task_id,opened_at) VALUES(?,'T2',?)").run(cycle, at);
            keys.push({ kind: 'wait_cycle', id: cycle });
          }
        }
        db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state,wait_cycle_id)
          SELECT ?,task_id,placement_id,placement_revision,task_hash,'new',?,'instruction',?,?,'queued',? FROM requests WHERE id=?`)
          .run(requestId, `Synthetic request ${operation.step}`,
            JSON.stringify(operation.variant % 2 ? { kind: 'human' } : { kind: 'placement', placementId: 'fixture-placement-2' }), at, cycle, request.id);
      });
      const template = bundles.flatMap(b => b.runs).find(run => run.task === owner) ?? ownRun;
      const newRun = { ...raw(template), id: `R${1000 + operation.step}`, task: owner, placementId: request.placementId, requestId,
        caller: operation.variant % 2 ? null : { run: 'R1' }, state: 'succeeded', into: null, resumes: null,
        reason: null, session: null, created_at: at, started_at: at, ended_at: new Date(Date.parse(at) + 1000).toISOString() };
      store.write(db => db.prepare("INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,?,'Synthetic result','present')")
        .run(1000 + operation.step, JSON.stringify(newRun), 'Synthetic request prompt'));
      keys.push({ kind: 'request', id: requestId }, { kind: 'run', id: newRun.id }); break;
    }
    case 'placement': {
      const active = own.placements.find(p => p.active);
      if (operation.variant % 2 === 0) {
        if (!active || own.runs.some(run => run.placementId === active.id && !isRunEnded(run.state))) break;
        store.write(db => db.prepare('UPDATE placements SET ended_at=?,revision=revision+1 WHERE id=? AND ended_at IS NULL').run(at, active.id));
        keys.push({ kind: 'placement', id: active.id });
      } else if (active) {
        store.write(db => db.prepare('UPDATE placements SET profile_key=?,revision=revision+1 WHERE id=? AND ended_at IS NULL').run(operation.variant % 3 ? 'fixture' : 'missing', active.id));
        keys.push({ kind: 'placement', id: active.id });
      } else if (own.task.meta.lifecycle === 'active') {
        const template = own.placements[0]!;
        const placement = `synthetic-placement-${operation.step}`;
        store.write(db => db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at)
          VALUES(?,?,?,'fixture',1,1,?)`).run(placement, id, template.agentId, at));
        keys.push({ kind: 'placement', id: placement });
      }
      break;
    }
    case 'dependency': {
      const after = id === 'T2' ? 'T3' : 'T2', seen = new Set<string>();
      const reaches = (task: string): boolean => {
        if (task === id) return true;
        if (seen.has(task)) return false;
        seen.add(task); return (before.bundle(task)?.after ?? []).some(reaches);
      };
      if (operation.variant % 2 && reaches(after)) break;
      store.write(db => { db.prepare('DELETE FROM task_dependencies WHERE task_id=?').run(id);
        if (operation.variant % 2) db.prepare('INSERT INTO task_dependencies(task_id,after_task_id) VALUES(?,?)').run(id, after); });
      keys.push({ kind: 'dependency', id }); break;
    }
    case 'move': {
      const parent = operation.target > 3 && operation.variant % 2 ? 'T2' : 'P1';
      if (['done', 'stopped'].includes(before.bundle(parent)!.task.meta.baseState)) break;
      store.write(db => db.prepare('UPDATE tasks SET parent_id=(SELECT id FROM tasks WHERE external_id=?),revision=revision+1 WHERE external_id=?').run(parent, id)); taskKey(); break;
    }
    case 'lifecycle':
      if (operation.variant % 2 === 0 && [...before.subtree(id)].some(child => before.bundle(child)!.runs.some(run => !isRunEnded(run.state)))) break;
      store.write(db => db.prepare('UPDATE tasks SET lifecycle=?,revision=revision+1 WHERE external_id=?').run(operation.variant % 2 ? 'active' : 'archived', id)); taskKey(); break;
    case 'run-state': {
      const status = ['running', 'succeeded', 'failed', 'needs_review'][operation.variant % 4] as 'running' | 'succeeded' | 'failed' | 'needs_review';
      const running = [own, ...bundles.filter(bundle => bundle !== own)].flatMap(bundle => bundle.runs).find(run => run.state === 'running');
      if (status !== 'running' && running) {
        store.write(db => db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify({ ...raw(running), state: status, ended_at: at,
          reason: status === 'failed' ? 'exit' : null, exit: { code: status === 'failed' ? 1 : 0, signal: null } }), Number(running.id.slice(1))));
        keys.push({ kind: 'run', id: running.id });
      } else execution(6000 + operation.step, status);
      break;
    }
    case 'run-usage-session': runPatch({ usage: { conversation: null,
      run: { input: (ownRun.usage?.run?.input ?? 0) + operation.variant, cacheRead: ownRun.usage?.run?.cacheRead ?? 0,
        cacheWrite: ownRun.usage?.run?.cacheWrite ?? 0, output: ownRun.usage?.run?.output ?? 0 }, includesEarlier: false },
      session: ownRun.session ?? { provider: null, id: `synthetic-session-${operation.step}` } }); break;
    case 'joined-resumes': {
      const other = bundles.flatMap(b => b.runs).find(run => run.id !== ownRun.id)!;
      const requestId = `synthetic-lineage-${operation.step}`, runId = `R${2000 + operation.step}`;
      store.write(db => {
        db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state)
          SELECT ?,task_id,placement_id,placement_revision,task_hash,'new','Synthetic lineage','instruction','{"kind":"human"}',?,'queued' FROM requests WHERE id=?`)
          .run(requestId, at, ownRun.requestId);
        db.prepare("INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,?,'Synthetic result','present')").run(2000 + operation.step,
          JSON.stringify({ ...ownRun, id: runId, requestId, state: operation.variant % 2 ? 'joined' : 'succeeded',
            caller: null, reason: null, exit: null, resumes: operation.variant % 2 ? null : other.id, into: operation.variant % 2 ? other.id : null, ended_at: at }), 'Synthetic lineage prompt');
      });
      keys.push({ kind: 'request', id: requestId }, { kind: 'run', id: runId }); break;
    }
    case 'delivery': {
      store.write(db => {
        // A late observation must not consume a released delivery or erase an earlier receipt/consumption.
        const consume = operation.variant % 2 === 1;
        const delivery = db.prepare(`SELECT return_id,wake_request_id FROM return_deliveries
          WHERE consumed_at IS NULL AND released_at IS NULL AND received_at IS ${consume ? 'NOT NULL' : 'NULL'}
          ORDER BY reserved_at,return_id,wake_request_id LIMIT 1`).get();
        if (!delivery) return;
        const column = consume ? 'consumed_at' : 'received_at';
        const changed = db.prepare(`UPDATE return_deliveries SET ${column}=? WHERE return_id=? AND wake_request_id=?
          AND consumed_at IS NULL AND released_at IS NULL AND received_at IS ${consume ? 'NOT NULL' : 'NULL'}`)
          .run(at, delivery.return_id, delivery.wake_request_id).changes;
        if (changed) keys.push({ kind: 'delivery', id: JSON.stringify([delivery.return_id, delivery.wake_request_id]) });
      });
      break;
    }
    case 'input-uncertain': {
      const run = execution(7000 + operation.step, 'running');
      if (!run) break;
      const runNo = Number(run.id.slice(1)), attempt = uuid(runNo), input = uuid(100000 + runNo);
      store.write(db => {
        db.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES(?,?,?)').run(runNo, attempt, attemptRecord(run, attempt));
        db.prepare(`INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial)
          VALUES(?,?,?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','uncertain',1)`).run(input, attempt, runNo);
      });
      keys.push({ kind: 'input', id: input }, { kind: 'attempt', id: String(runNo) }); break;
    }
    case 'files': state.externalFiles.set(id, [{ name: `synthetic-${operation.step}.txt`, revision: String(operation.step), size: 8 }]); keys.push({ kind: 'files', id }); break;
    case 'config': state.lowAutomaticLimit = !state.lowAutomaticLimit; { const config = parse(readFileSync(join(store.root, 'config.yaml'), 'utf8')); config.limits = { automatic_per_placement: state.lowAutomaticLimit ? 1 : 20 }; writeFileSync(join(store.root, 'config.yaml'), stringify(config)); } keys.push({ kind: 'config', id: '*' }); break;
    case 'person': state.fresh = !state.fresh; keys.push({ kind: 'person', id: 'notices' }); break;
    case 'read-failure': break; // The driver injects a real reader failure before this mutation.
    case 'error-cause': {
      const failed = [own, ...bundles.filter(bundle => bundle !== own)].flatMap(bundle => bundle.runs)
        .find(run => run.state === 'failed' && (run.reason === 'exit' || run.reason === 'output'));
      if (!failed) break;
      if (!failed.session) {
        store.write(db => db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify({ ...raw(failed), session: { provider: null, id: `synthetic-session-${operation.step}` } }), Number(failed.id.slice(1))));
        keys.push({ kind: 'run', id: failed.id });
      }
      state.causes.set(failed.id, operation.variant % 2 ? 'weekly_limit' : 'model_capacity'); keys.push({ kind: 'activity', id: failed.id }); break;
    }
    case 'schema': {
      const custom = { ...before.catalog().get('notes')!, id: 'synthetic_field', title: `Synthetic field ${operation.step}`, required: false };
      store.write(db => {
        db.prepare('INSERT INTO field_defs(id,definition,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition,updated_at=excluded.updated_at').run(custom.id, JSON.stringify(custom), at);
        db.prepare("DELETE FROM project_fields WHERE project_task_id=(SELECT id FROM tasks WHERE external_id='P1')").run();
        for (const [position, field] of [...DEFAULT_SCHEMA, custom.id].entries()) db.prepare("INSERT INTO project_fields(project_task_id,position,field_id) VALUES((SELECT id FROM tasks WHERE external_id='P1'),?,?)").run(position, field);
      });
      keys.push({ kind: 'field_def', id: custom.id }, { kind: 'project_field', id: 'P1' }); break;
    }
    case 'return': {
      log('reported', { title: 'Synthetic work change' });
      const cause = { id: `replay-log-${operation.step}` };
      const to = id === 'T2' ? 'T3' : 'T2', returned = `synthetic-return-${operation.step}`;
      store.write(db => db.prepare("INSERT INTO returns(id,to_task_id,outcome,cause_log_id,created_at) VALUES(?,?,'work_changed',?,?)").run(returned, to, cause.id, at));
      keys.push({ kind: 'return', id: returned }); break;
    }
    case 'joined-delivery': {
      const receiver = bundles.flatMap(b => b.runs).find(run => run.task !== runOwner && !run.id.startsWith('R2'))!;
      const request = `synthetic-wake-${operation.step}`, no = 3000 + operation.step, proxy = `R${no}`;
      const returned = `synthetic-joined-return-${operation.step}`, input = uuid(100000 + no), attempt = uuid(no);
      const source = bundles.find(b => b.task.id !== runOwner && b.task.meta.kind === 'task')!.task.id;
      log('reported', { title: 'Synthetic cause delivered through a joined Run' }, source);
      const cause = { id: `replay-log-${operation.step}` };
      store.write(db => {
        db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state)
          SELECT ?,task_id,placement_id,placement_revision,task_hash,'new','Synthetic uncertain receipt','return_continuation',?,?,'queued' FROM requests WHERE id=?`).run(request, JSON.stringify({kind: 'placement', placementId: ownRun.placementId}), at, ownRun.requestId);
        db.prepare("INSERT INTO runs(id,record,prompt,result_state) VALUES(?,?,?,'missing')").run(no, JSON.stringify({ ...ownRun, id: proxy, requestId: request, caller: null, resumes: null, reason: null, exit: null, state: 'joined', into: receiver.id, ended_at: at }), 'Synthetic joined receipt');
        db.prepare("INSERT INTO returns(id,to_task_id,outcome,cause_log_id,created_at) VALUES(?,?,'work_changed',?,?)").run(returned, runOwner, cause.id, at);
        db.prepare('INSERT INTO return_deliveries(return_id,wake_request_id,reserved_at,received_at) VALUES(?,?,?,?)').run(returned, request, at, at);
        db.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES(?,?,?)').run(no, attempt, attemptRecord({ ...ownRun, id: proxy }, attempt));
        db.prepare("INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial) VALUES(?,?,?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','uncertain',0)").run(input, attempt, no);
      });
      keys.push({ kind: 'request', id: request }, { kind: 'run', id: proxy }, { kind: 'return', id: returned },
        { kind: 'delivery', id: JSON.stringify([returned, request]) }, { kind: 'input', id: input }, { kind: 'attempt', id: attempt });
      break;
    }
    case 'delivery-uncertain': {
      const pending = store.read(db => db.prepare("SELECT input_id,instruction_run_no FROM run_inputs WHERE instruction_run_no>=3000 AND instruction_run_no<4000 AND state='uncertain' ORDER BY instruction_run_no DESC LIMIT 1").get());
      if (pending) {
        store.write(db => db.prepare("UPDATE run_inputs SET state='taken' WHERE input_id=? AND state='uncertain'").run(String(pending.input_id)));
        keys.push({ kind: 'input', id: String(pending.input_id) });
      }
      break;
    }
    case 'wait-cycle': {
      const open = new Set(store.read(db => db.prepare('SELECT task_id FROM wait_cycles WHERE closed_at IS NULL').all().map(row => String(row.task_id))));
      const sender = bundles.find(bundle => bundle.runs.length && bundle.placements.length && !open.has(bundle.task.id));
      if (!sender) break;
      const caller = sender.runs[0]!, recipient = bundles.find(bundle => bundle.runs.length && bundle.task.id !== sender.task.id)!;
      const template = raw(recipient.runs[0]!), cycle = `synthetic-cycle-${operation.step}`, request = `synthetic-cycle-request-${operation.step}`;
      const no = 5000 + operation.step;
      store.write(db => {
        db.prepare('INSERT INTO wait_cycles(id,task_id,opened_at) VALUES(?,?,?)').run(cycle, sender.task.id, at);
        db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state,wait_cycle_id)
          SELECT ?,task_id,placement_id,placement_revision,task_hash,'new','Synthetic child completing a wait','instruction',?,?,'queued',? FROM requests WHERE id=?`)
          .run(request, JSON.stringify({ kind: 'placement', placementId: caller.placementId }), at, cycle, template.requestId);
        db.prepare("INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,'Synthetic child prompt','Synthetic completed child','present')")
          .run(no, JSON.stringify({ ...template, id: `R${no}`, requestId: request, caller: { run: caller.id }, resumes: null,
            state: 'succeeded', reason: null, exit: { code: 0, signal: null }, into: null, created_at: at, started_at: at, ended_at: at }));
      });
      keys.push({ kind: 'wait_cycle', id: cycle }, { kind: 'request', id: request }, { kind: 'run', id: `R${no}` });
      break;
    }
    case 'coordinator-complete': {
      const row = store.read(db => db.prepare("SELECT id,record FROM runs WHERE json_extract(record,'$.role')='coordinator' AND json_extract(record,'$.state')='running' ORDER BY id DESC LIMIT 1").get());
      if (row) {
        const record = JSON.parse(String(row.record));
        store.write(db => db.prepare("UPDATE runs SET record=?,result=?,result_state='present' WHERE id=?").run(JSON.stringify({ ...record, state: 'succeeded', ended_at: at }), `Synthetic coordinator completion ${operation.step}`, row.id));
        keys.push({ kind: 'run', id: `R${row.id}` });
      }
      break;
    }
    case 'coordinator-join': {
      const conversation = store.read(db => db.prepare('SELECT id FROM coordinator_conversations WHERE cleared_at IS NULL').get()?.id) ?? '00000000-0000-4000-8000-000000000001';
      const no = 4000 + operation.step * 2, message = `synthetic-message-${operation.step}`, joined = `${message}-joined`;
      store.write(db => {
        db.prepare('INSERT OR IGNORE INTO coordinator_conversations(id,started_at) VALUES(?,?)').run(conversation, at);
        for (const request of [message, joined]) db.prepare(`INSERT INTO requests(id,conversation_id,mode,body,purpose,author,submitted_at,delivery_state)
          VALUES(?,?,'new','Synthetic coordinator message','instruction','{"kind":"human"}',?,'queued')`).run(request, conversation, at);
        const actual = coordinatorRecord(`R${no}`, { requestId: message, conversationId: String(conversation), state: 'running', ended_at: null });
        const proxy = coordinatorRecord(`R${no+1}`, { requestId: joined, conversationId: String(conversation), state: 'joined', into: actual.id, ended_at: at });
        for (const run of [actual, proxy]) db.prepare("INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,'Synthetic coordinator prompt','Synthetic coordinator answer','present')").run(Number(run.id.slice(1)), JSON.stringify(run));
        db.prepare('INSERT INTO task_dialogues(task_uuid,request_id) SELECT id,? FROM tasks WHERE external_id=?').run(joined, id);
      });
      const uuid = store.read(db => String(db.prepare('SELECT id FROM tasks WHERE external_id=?').get(id)!.id));
      keys.push({ kind: 'conversation', id: String(conversation) }, { kind: 'request', id: message }, { kind: 'request', id: joined },
        { kind: 'run', id: `R${no}` }, { kind: 'run', id: `R${no+1}` }, { kind: 'dialogue', id: JSON.stringify([uuid, joined]) });
      break;
    }
  }
  return { keys };
}
