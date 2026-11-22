/** Discover a finite audit read set, then refresh it in batches at the caller's SQLite read point. */
import type { DatabaseSync } from 'node:sqlite';
import type { ChangeKey } from '@alpacawork/db';
import { currentRequestRun } from '@alpacawork/runs';
import type { RunId } from '@alpacawork/contract';
import type { RecordsReader, TaskBundle } from './projection-contract.js';
import { DatabaseWorkspaceRecords, ownerLookup } from './workspace-records.js';
import { finishRecords, type RecordWork } from './record-work.js';
import { readPoint } from './workspace-records-sql.js';

const asRun = (id: unknown) => `R${id}` as RunId;
const identity = (key: ChangeKey) => JSON.stringify(key);

/**
 * Getters only discover reads. In particular, a closing Return never decodes its destination's entire Return history
 * inside each Request lookup. Each discovery round refreshes all pending bundles and keys together, then retries the
 * selected Tasks. The result is usable only after a round discovers no additional reads.
 */
export function auditCandidate(db: DatabaseSync, original: DatabaseWorkspaceRecords,
  tasks: readonly string[], keys: readonly ChangeKey[]) {
  let current = original;
  const loaded = new Set<string>(), pendingTasks = new Set(tasks);
  const applied = new Set<string>(), requested = new Map<string, ChangeKey>();
  const pendingKeys = new Map(keys.map(key => [identity(key), key]));
  const runs = new Set<string>(), children = new Set<string>(), inputs = new Set<string>(), referrers = new Set<string>();
  const closed = new Set<string>(), targets = new Map<string, TaskBundle['runs'] | undefined>();
  const owners = new Map<string, string | undefined>();
  const requests = new Map<string, { id: RunId; into: RunId | undefined } | undefined>();
  const awaitingBundle = Symbol('audit bundle has not been refreshed');
  const childRows = db.prepare('SELECT external_id FROM tasks WHERE parent_id=(SELECT id FROM tasks WHERE external_id=?)');
  const inputRows = db.prepare('SELECT input_id FROM run_inputs WHERE instruction_run_no=?');
  const requestRun = db.prepare(`SELECT id,into_id FROM runs WHERE id=(${currentRequestRun('?')})`);
  const callerRuns = db.prepare('SELECT id,task_id FROM runs WHERE caller_run=?');
  const closingReturns = db.prepare('SELECT id FROM returns WHERE request_id=? AND request_id IS NOT NULL');
  const callers = new Map<RunId, ReturnType<typeof callerRuns.all>>();
  const calling = (id: RunId) => {
    if (!callers.has(id)) callers.set(id, callerRuns.all(id));
    return callers.get(id)!;
  };
  const need = (key: ChangeKey) => {
    const name = identity(key);
    requested.set(name, key);
    if (!applied.has(name)) pendingKeys.set(name, key);
  };
  const bundle = (id: string) => {
    if (!loaded.has(id)) {
      pendingTasks.add(id);
      // Existing bundles let discovery continue across every selected Task in the same round. A newly referenced
      // Task has no safe stand-in: retry its derivation after the pending batch has discovered that bundle.
      if (!current.bundle(id)) throw awaitingBundle;
    }
    return current.bundle(id);
  };
  const run = (id: RunId) => {
    need({ kind: 'run', id });
    if (!runs.has(id)) {
      runs.add(id);
      const owner = ownerLookup.run(db, [id]).get(id)?.task;
      if (owner && !loaded.has(owner)) pendingTasks.add(owner);
    }
    return current.run(id);
  };
  const request = (id: string) => {
    if (!requests.has(id)) {
      const row = requestRun.get(id), old = current.runByRequest(id);
      requests.set(id, row ? { id: asRun(row.id), into: row.into_id == null ? undefined : String(row.into_id) as RunId } : undefined);
      if (old) run(old);
    }
    const value = requests.get(id);
    if (value) run(value.id);
    return value;
  };
  const discoverTargets = (id: string) => {
    const ownRuns = bundle(id)?.runs;
    if (!targets.has(id) || targets.get(id) !== ownRuns) {
      for (const own of ownRuns ?? []) for (const row of calling(own.id)) {
        run(asRun(row.id)); if (row.task_id != null) bundle(String(row.task_id));
      }
      // Old destinations remain evidence when a receiving Run or Request disappeared from the database.
      for (const target of original.targetsFromAll(id)) bundle(target);
      targets.set(id, ownRuns);
    }
  };
  const reader: RecordsReader = new Proxy(original, {
    get(_target, property) {
      if (property === 'bundle') return bundle;
      if (property === 'run') return run;
      if (property === 'children') return (id: string) => {
        if (!children.has(id)) {
          children.add(id);
          for (const child of new Set([...current.children(id), ...childRows.all(id).map(row => String(row.external_id))]))
            need({ kind: 'task', id: child });
        }
        return current.children(id);
      };
      if (property === 'inputsByInstruction') return (id: RunId) => {
        if (!inputs.has(id)) {
          inputs.add(id);
          for (const input of new Set([...current.inputsByInstruction(id), ...inputRows.all(Number(id.slice(1))).map(row => String(row.input_id))]))
            need({ kind: 'input', id: input });
        }
        return current.inputsByInstruction(id);
      };
      if (property === 'runByRequest') return (id: string) => request(id)?.id;
      if (property === 'coordinatorRun') return (message: string) => {
        const value = request(message);
        if (value?.into) run(value.into);
        return current.coordinatorRun(message);
      };
      if (property === 'runOwner') return (id: RunId) => { run(id); return current.runOwner(id); };
      if (property === 'runReferrers') return (id: RunId) => {
        if (!referrers.has(id)) {
          referrers.add(id);
          for (const ref of new Set([...current.runReferrers(id), ...calling(id).map(row => asRun(row.id))])) run(ref);
        }
        return current.runReferrers(id);
      };
      if (property === 'logOwner' || property === 'placementOwner' || property === 'requestOwner' || property === 'returnOwner') return (id: string) => {
        const kind = ({ logOwner: 'log', placementOwner: 'placement', requestOwner: 'request', returnOwner: 'return' } as const)[property];
        const name = identity({ kind, id });
        if (!owners.has(name)) owners.set(name, ownerLookup[kind](db, [id]).get(id)?.task ?? undefined);
        const owner = owners.get(name);
        if (owner) bundle(owner);
        return owner ?? (property === 'requestOwner' ? null : undefined);
      };
      if (property === 'closedRequest') return (id: string) => {
        if (!closed.has(id)) {
          closed.add(id);
          for (const returned of new Set([...current.closingReturnIds(id), ...closingReturns.all(id).map(row => String(row.id))]))
            need({ kind: 'return', id: returned });
        }
        return current.closedRequest(id);
      };
      if (property === 'targetsFromAll' || property === 'sentRequests') return (id: string) => {
        discoverTargets(id);
        return current[property](id);
      };
      // Internal ancestry and relation lookups go through the same discovery reader.
      const value = Reflect.get(current, property);
      return typeof value === 'function' ? value.bind(reader) : value;
    },
  }) as RecordsReader;
  function* refresh(): RecordWork<void> {
    const tasks = [...pendingTasks], keys = [...pendingKeys.values()];
    pendingTasks.clear(); pendingKeys.clear();
    const change = tasks.length
      ? yield* current.reloadBundleSteps(db, tasks, original.pv, keys)
      : yield* current.advanceSteps(db, keys, original.pv);
    current = change.next;
    change.keys.forEach(key => applied.add(identity(key)));
    for (const id of tasks) {
      loaded.add(id);
      for (const item of [...(original.bundle(id)?.runs ?? []), ...(current.bundle(id)?.runs ?? [])]) runs.add(item.id);
    }
  }
  function* readSteps<T>(read: (task: string) => RecordWork<T>): RecordWork<Map<string, T>> {
    while (true) {
      if (pendingTasks.size || pendingKeys.size) yield* refresh();
      const values = new Map<string, T>();
      for (const task of tasks) {
        yield;
        try { values.set(task, yield* read(task)); }
        catch (error) {
          // A discovery round may temporarily mix old and refreshed related bundles. Stable errors still escape.
          if (error !== awaitingBundle && !pendingTasks.size && !pendingKeys.size) throw error;
        }
      }
      if (!pendingTasks.size && !pendingKeys.size) return values;
    }
  }
  return {
    reader, loaded, readSteps, records: () => current, keys: () => [...requested.values()],
    /** Discovery failures for one new bundle must not prevent the other selected Tasks joining the batch. */
    read<T>(read: (task: string) => T): Map<string, T> {
      return readPoint(db, () => finishRecords(readSteps(function* (task) { return read(task); })));
    },
  };
}
