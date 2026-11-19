import { initializeControlFixture } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
/** Verify the real SQLite and filesystem boundary, including killed writers. */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, mkdirSync, readFileSync, existsSync, statSync, symlinkSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { RunStore, usesSlot, conversationInUse, type CreateCoordinatorRunFields, type CreateRunFields, type NewRequest,
  type RunTransaction } from '@alpacawork/runs';
import { runRecordSchema } from '@alpacawork/contract/run';
import { Problem } from '@alpacawork/core';
import { openDatabase } from '@alpacawork/db';
import { fields as runFields, coordinatorFields, time } from './runs-fixtures.ts';
// P1 is the workspace's root project and `project` the fixture's project below it; the Runs work on its two tasks.
let area: string, project: string, firstTask: string, secondTask: string;
beforeEach(async () => {
  area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-runs-')));
  project = initializeControlFixture(area);
  [firstTask, secondTask] = (await new ControlTaskCommands(area, { kind: 'human' }).create({ parentId: project, userRequested: false,
    tasks: [{ title: 'First' }, { title: 'Second' }] })).tasks.map(task => task.id);
});
afterEach(() => rmSync(area, { recursive: true, force: true }));
const open = (busyTimeoutMs = 1000) => new RunStore(area, { busyTimeoutMs });
/** A Run on the first task unless `overrides` names another. */
const fields = (overrides: Partial<CreateRunFields> = {}) => runFields({ task: firstTask, ...overrides });

test('Request body reads preserve SQLite text ordering and the current transaction, including unassigned Requests', () => {
  const store = open();
  try {
    const run = store.write(tx => createFixtureRun(store, tx, fields(), 'assigned'));
    store.write(tx => {
      const { runId, ...base } = tx.getRequest(run.requestId)!;
      const keys = [
        ['Rq😀', 'same'], ['Rq\uE000', 'same'], ['RqA\0Z', 'same'], ['Rqa', 'same'], ['RqZ', 'same'],
        ['Rq-offset', '2026-10-19T01:00:00+09:00'], ['Rq-utc', '2026-10-18T20:00:00Z'],
      ];
      for (const [id, submittedAt] of keys) tx.insertRequest({ ...base, id, submittedAt, body: 'large body\n'.repeat(10000) });
      // Different invalid UTF-8 identities both decode to U+FFFD in the Node driver. Their original BINARY order
      // still owns output/error order; a JavaScript Map keyed by the decoded public ID would collapse them.
      for (const [hex, body] of [['81', 'invalid-text-B'], ['80', 'invalid-text-A']])
        store.connection.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,
          wait_cycle_id,head_run_id,mode,body,purpose,author,submitted_at,delivery_state)
          SELECT CAST(x'${hex}' AS TEXT),task_id,placement_id,placement_revision,task_hash,
          wait_cycle_id,head_run_id,mode,?,purpose,author,'same',delivery_state FROM requests WHERE id=?`)
          .run(body, run.requestId);
      const expected = store.connection.prepare('SELECT id FROM requests WHERE task_id IS NOT NULL ORDER BY submitted_at,id')
        .all().map(row => String(row.id));
      const actual = tx.requests();
      assert.deepEqual(actual.map(request => request.id), expected);
      assert.equal(actual.find(request => request.id === run.requestId)?.runId, run.id);
      assert.ok(actual.filter(request => request.id !== run.requestId).every(request => request.runId === null));
      assert.equal(actual.find(request => request.id === keys[0]![0])?.body.length, 110000);
      assert.deepEqual(actual.filter(request => request.body.startsWith('invalid-text-')).map(request => request.body),
        ['invalid-text-A', 'invalid-text-B']);
    });
    assert.deepEqual(store.readRequests('P999'), []);
  } finally { store.close(); }
});
function inspect(fn: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(join(area, '.alpacawork/alpacawork.sqlite'));
  try { fn(db); } finally { db.close(); }
}
function child(mode: string, timeout = 1000) {
  const process = spawn(globalThis.process.execPath,
    [join(import.meta.dirname, 'runs-store-child.ts'), area, mode, String(timeout), firstTask], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; process.stderr.on('data', chunk => { stderr += chunk; });
  const done=once(process,'exit'),expiry=setTimeout(()=>process.kill('SIGKILL'),20000);void done.finally(()=>clearTimeout(expiry));
  const ready=Promise.race([once(process,'message'),done.then(()=>{throw Error(stderr||'Store subject exited before readiness')})]);void ready.catch(()=>undefined);
  return { process, ready, done, stderr: () => stderr };
}

test('numbering, prompt in the control DB, WAL, and no runs.lock', () => {
  const store = open();
  try {
    const one = store.write(tx => createFixtureRun(store, tx, fields(), 'first prompt'));
    assert.equal(one.id, 'R1');
    assert.equal(store.write(tx => createFixtureRun(store, tx, fields(), 'second')).id, 'R2');
    assert.equal(store.write(tx => createFixtureRun(store, tx, fields(), 'third')).id, 'R3');
    assert.deepEqual(store.read().map(run => run.id), ['R1', 'R2', 'R3']);
    assert.equal(store.getText('R1')?.prompt, 'first prompt');
    assert.equal(statSync(join(area, '.alpacawork')).mode & 0o777, 0o700);
    assert.equal(statSync(join(area, '.alpacawork/alpacawork.sqlite')).mode & 0o777, 0o600);
    assert.equal(existsSync(join(area, '.alpacawork/runs.lock')), false);
    assert.equal(existsSync(join(area, '.alpacawork/alpacawork.sqlite.lock')), false);
    assert.throws(() => store.folder('../escape'));
    inspect(db => {
      assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
      assert.ok(db.prepare("SELECT name FROM pragma_table_info('returns')").all().length > 0);
    });
  } finally { store.close(); }
});

test('a control DB file is integrity-checked on its first open in a process, and again once another file takes its place', t => {
  open().close();
  const prepare = DatabaseSync.prototype.prepare;
  let checks = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (this: DatabaseSync, sql: string) {
    if (sql === 'PRAGMA quick_check') checks++;
    return prepare.call(this, sql);
  });
  const read = () => {
    const reader = RunStore.openReadable(area, { busyTimeoutMs: 0 });
    assert.ok(reader);
    reader.close();
  };
  // This process made and opened the file before: it was found sound then.
  read(); read();
  assert.equal(checks, 0);
  // A restored copy put in its place is another file.
  const file = join(area, '.alpacawork/alpacawork.sqlite');
  inspect(db => db.exec(`VACUUM INTO '${file}.copy'`));
  renameSync(`${file}.copy`, file);
  read(); read();
  assert.equal(checks, 1);
});

test('resend creation and predecessor failure commit together or both roll back', () => {
  const store = open();
  try {
    const original = store.write(tx => {
      const run = createFixtureRun(store, tx, fields(), 'original');
      tx.update({ ...run, state: 'running', started_at: time });
      const review = { ...run, state: 'needs_review', reason: 'conversation_busy' } as const;
      tx.update(review); return review;
    });
    const resend = (tx: RunTransaction) => {
      const run = createFixtureRun(store, tx, fields({ resumes: original.id }), 'resend');
      tx.update({ ...original, state: 'failed', reason: 'conversation_busy', ended_at: time });
      return run;
    };
    assert.throws(() => store.write(tx => { resend(tx); throw new Error('abort'); }), /abort/);
    assert.deepEqual(store.read(), [original]);
    const created = store.write(resend);
    assert.equal(created.id, 'R2');
    assert.equal(store.read()[0].state, 'failed');
    assert.equal(store.read().length, 2);
    for (const dangling of [{ resumes: 'R99' }, { caller: { run: 'R99' } }])
      assert.throws(() => store.write(tx => createFixtureRun(store, tx, fields(dangling), 'dangling')), { code: 'not_found' });
    assert.equal(store.read().length, 2);
  } finally { store.close(); }
});

test('update guards roll back all earlier writes and a launched Run keeps its session', () => {
  const store = open();
  try {
    const one = store.write(tx => createFixtureRun(store, tx, fields(), 'one'));
    for (const change of [
      { id: 'R99' }, { task: secondTask }, { agent: 'other' }, { role: 'worker' }, { resumes: 'R2' },
      { resumes: 'R2', continues: true }, { caller: { run: 'R2' } }, { cwd: '/elsewhere' },
      { launch: { ...one.launch, path: '/usr/bin' } }, { created_at: time }, { state: 'failed', reason: 'exit', ended_at: time },
    ]) {
      assert.throws(() => store.write(tx => {
        tx.update({ ...one, stop_requested: true });
        tx.update({ ...one, ...change } as typeof one);
      }));
      assert.deepEqual(store.read(), [one]);
    }
    // A queued Run may still take a fresh session (its predecessor's first launch failed).
    const queuedSession = { ...one, session: { provider: null, id: 'first' } };
    store.write(tx => tx.update(queuedSession));
    store.write(tx => tx.update({ ...queuedSession, session: { provider: null, id: 'local' } }));
    const assigned = { ...one, session: { provider: null, id: 'local' }, state: 'running' as const, started_at: time };
    store.write(tx => tx.update(assigned));
    for (const session of [null, { provider: null, id: 'another' }, { provider: 'codex', id: 'local' }])
      assert.throws(() => store.write(tx => { createFixtureRun(store, tx, fields(), 'rollback'); tx.update({ ...assigned, session } as typeof one); }), { code: 'conflict' });
    store.write(tx => tx.update({ ...assigned, pids: { manager: 12, agent: 13 } }));
    assert.equal(store.read().length, 1);
  } finally { store.close(); }
});

test('malformed JSON and invalid stored records fail closed', () => {
  const store = open();
  try {
    const one = store.write(tx => createFixtureRun(store, tx, fields(), 'one'));
    assert.throws(() => inspect(db => db.prepare('UPDATE runs SET record = ?').run('{')), /malformed JSON/);
    assert.throws(() => inspect(db => db.prepare('UPDATE runs SET record = ?').run(JSON.stringify({ ...one, id: 'R2' }))), /CHECK/);
    inspect(db => db.prepare('UPDATE runs SET record = ?').run(JSON.stringify({ ...one, extra: 1 })));
    assert.throws(() => store.read(), { code: 'runs_unavailable' });
    assert.throws(() => store.write(tx => tx.all()), { code: 'runs_unavailable' });
  } finally { store.close(); }
});

for (const [field, old] of [
  ['requestId', { requestId: null }],
  ['continues', { continues: true, resumes: 'R1' }],
  ['caller', { caller: { session: { provider: 'codex', id: 'old-session' } } }],
] as const) test(`legacy ${field} is refused on creation and every stored Run read`, () => {
  const store = open();
  try {
    const current = store.write(tx => createFixtureRun(store, tx, fields(), 'current'));
    assert.throws(() => store.write(tx => tx.create({ ...fields(), ...old } as unknown as CreateRunFields, 'old')),
      error => error instanceof Problem && error.code === 'runs_unavailable' && error.message.includes(field));
    assert.deepEqual(store.read(), [current], 'rejection does not write or reinterpret the input');
    const invalid = JSON.stringify({ ...current, ...old });
    if (field === 'requestId' || field === 'continues') {
      assert.throws(() => inspect(db => db.prepare('UPDATE runs SET record = ? WHERE id = 1').run(invalid)),
        /witness mismatch|run ownership is immutable/);
      assert.deepEqual(store.read(), [current], 'the Run witness remains linked to its original Task and Request');
    } else {
      inspect(db => db.prepare('UPDATE runs SET record = ? WHERE id = 1').run(invalid));
      assert.throws(() => store.read(), { code: 'runs_unavailable' },
        'a stored legacy record fails closed at the Run read boundary');
      assert.throws(() => store.write(tx => tx.all()), { code: 'runs_unavailable' });
    }
  } finally { store.close(); }
});

test('transaction handles expire, callback errors roll back, and async callbacks are rejected', () => {
  const store = open(); let saved: RunTransaction;
  try {
    store.write(tx => { saved = tx; });
    assert.throws(() => saved.all(), { code: 'conflict' });
    assert.throws(() => saved.create(fields(), 'late'), { code: 'conflict' });
    assert.throws(() => store.write(tx => { createFixtureRun(store, tx, fields(), 'async'); return Promise.resolve(); }), /synchronous/);
    assert.deepEqual(store.read(), []);
    assert.throws(() => store.write(() => store.read()), { code: 'conflict' });
    assert.throws(() => store.write(() => store.close()), { code: 'conflict' });
  } finally { store.close(); }
  assert.throws(() => store.read(), { code: 'conflict' });
});

test('an ordinary root alias reads the existing DB; an uninitialized alias stays uninitialized', () => {
  const original = open();
  let saved: ReturnType<typeof original.read>[number];
  try { saved = original.write(tx => createFixtureRun(original, tx, fields(), 'through the real root')); }
  finally { original.close(); }
  const alias = join(area, 'alias'); symlinkSync(area, alias, 'dir');
  const linked = new RunStore(alias, { busyTimeoutMs: 0 });
  try { assert.deepEqual(linked.read(), [saved!]); }
  finally { linked.close(); }
  const empty = join(area, 'empty'), emptyAlias = join(area, 'empty-alias');
  mkdirSync(empty); symlinkSync(empty, emptyAlias, 'dir');
  assert.equal(RunStore.exists(emptyAlias), false);
  assert.throws(() => new RunStore(emptyAlias, { busyTimeoutMs: 0 }), error => {
    assert.equal((error as Problem).code, 'runs_unavailable');
    assert.equal(((error as Error).cause as NodeJS.ErrnoException).code, 'ENOENT'); return true;
  });
  assert.deepEqual(readdirSync(empty), [], 'opening an alias never initializes missing storage');
});

test('WAL readers keep a committed snapshot while one owner writes; competing owners fail before SQLite', async () => {
  const reader=RunStore.openReadable(area,{busyTimeoutMs:1000})!,holder=child('hold');
  const subjects=[holder];
  try{
    await holder.ready;const holding=once(holder.process,'message');holder.process.send('go');await holding;
    const started=performance.now();assert.deepEqual(reader.read(),[]);assert.ok(performance.now()-started<500);
    const short=child('write',30),long=child('write',5000);subjects.push(short,long);
    for(const item of[short,long]){await assert.rejects(item.ready,/Another serve writer/);assert.notEqual((await item.done)[0],0)}
    assert.equal((await holder.done)[0],0,holder.stderr());assert.equal(reader.read().length,1);
    const successor=child('write');subjects.push(successor);await successor.ready;const saved=once(successor.process,'message');successor.process.send('go');assert.deepEqual((await saved)[0],{saved:'R2'});assert.equal((await successor.done)[0],0,successor.stderr());assert.equal(reader.read().length,2);
  }finally{reader.close();for(const item of subjects)if(item.process.exitCode===null&&item.process.signalCode===null){item.process.kill('SIGKILL');await item.done}}
});

for (const mode of ['before', 'after']) test(`SIGKILL ${mode} commit preserves crash contract`, async () => {
  open().close(); const worker = child(mode);
  try {
    await worker.ready;
    const checkpoint = once(worker.process, 'message'); worker.process.send('go');
    assert.deepEqual((await checkpoint)[0], mode === 'before' ? { created: 'R1' } : { committed: 'R1' });
    worker.process.kill('SIGKILL'); assert.equal((await worker.done)[1], 'SIGKILL');
    const store = open();
    try {
      assert.equal(store.read().length, mode === 'before' ? 0 : 1);
      for (const record of store.read()) assert.ok(runRecordSchema.safeParse(record).success);
      assert.equal(mode === 'before' ? store.getText('R1') : store.getText('R1')?.prompt, mode === 'before' ? null : 'after crash');
      assert.equal(store.write(tx => createFixtureRun(store, tx, fields(), 'after recovery')).id, mode === 'before' ? 'R1' : 'R2');
      inspect(db => assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok'));
    } finally { store.close(); }
  } finally { if (worker.process.exitCode === null && worker.process.signalCode === null) { worker.process.kill('SIGKILL'); await worker.done; } }
});

test('filtered decision reads preserve full-snapshot decisions and required relationship closure', () => {
  const store = open();
  try {
    const fixture = store.write(tx => {
      const put = (extra: Partial<CreateRunFields> = {}, state = 'succeeded', reason: string | null = null) => {
        const run = createFixtureRun(store, tx, fields(extra), 'decision fixture');
        tx.update({ ...run, state: 'running' });
        const result = { ...run, state, reason, ended_at: ['succeeded', 'failed', 'cancelled'].includes(state) ? time : null } as typeof run;
        if (state === 'succeeded') tx.finish(result, { state: 'present', text: 'fixture reply' });
        else tx.update(result); return result;
      };
      const archive = put({ session: { provider: 'claude', id: 'archived' } });
      const complete = put({ session: { provider: 'codex', id: 'completed' } });
      put({ caller: { run: complete.id }, role: 'worker' });
      put({ resumes: complete.id, caller: { run: complete.id }, session: complete.session });
      const parent = put({ session: { provider: 'codex', id: 'parent' } });
      const first = put({ caller: { run: parent.id }, role: 'worker' });
      const next = put({ caller: { run: first.id }, resumes: first.id, role: 'worker' });
      const active = put({ caller: { run: next.id }, session: { provider: 'codex', id: 'active' }, role: 'worker' }, 'running');
      const counting = put({ session: parent.session, resumes: archive.id });
      const waiting = put({ session: { provider: 'codex', id: 'occupied' } });
      put({ caller: { run: waiting.id }, role: 'worker' });
      put({ session: waiting.session }, 'needs_review', 'manager_lost');
      return { archive, complete, parent, active, counting };
    });
    store.write(tx => {
      const all = tx.all(), selected = tx.forSettle();
      assert.ok(selected.length < all.length);
      assert.ok(!selected.some(run => run.id === fixture.archive.id), 'Unrelated completed history is omitted');
      assert.ok(!selected.some(run => run.id === fixture.counting.id), 'Unrelated budget history comes from the separate history snapshot');
      assert.equal(selected.filter(usesSlot).length, all.filter(usesSlot).length);
      for (const session of ['parent', 'active', 'occupied', 'completed'])
        assert.equal(conversationInUse(selected, session), conversationInUse(all, session));
    });
  } finally { store.close(); }
});


test('a corrupted control DB reports runs_unavailable', () => {
  open().close();
  writeFileSync(join(area, '.alpacawork/alpacawork.sqlite'), 'corrupt database');
  assert.throws(() => open(), { code: 'runs_unavailable', status: 503 });
  assert.equal(readFileSync(join(area, '.alpacawork/alpacawork.sqlite'), 'utf8'), 'corrupt database');
  // The host database keeps its own failure code.
  const file = join(area, 'host.sqlite');
  writeFileSync(file, 'corrupt database');
  assert.throws(() => openDatabase(file, 'host', { busyTimeoutMs: 3000 }), { code: 'database_unavailable', status: 503 });
});

test('store classifies its filesystem faults and preserves callback errors and Problems', () => {
  const faultRoot = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-runs-fault-')));
  try {
    assert.equal(RunStore.exists(faultRoot), false);
    writeFileSync(join(faultRoot, '.alpacawork'), 'not a directory');
    assert.throws(() => RunStore.exists(faultRoot), { code: 'runs_unavailable', status: 503 });
    assert.throws(() => new RunStore(faultRoot, { busyTimeoutMs: 0 }), { code: 'invalid_root', status: 409, reason: { kind: 'control_database_absent' } });
    assert.equal(readFileSync(join(faultRoot, '.alpacawork'), 'utf8'), 'not a directory');
  } finally { rmSync(faultRoot, { recursive: true, force: true }); }
  const store = open();
  try {
    for (const error of [new Error('caller error'), new Problem('conversation_busy', 'refusal'), Object.assign(new Error('caller busy'), { errcode: 5 })])
      assert.throws(() => store.write(() => { throw error; }), actual => actual === error);
  } finally { store.close(); }
});

test('store classifies BEGIN, statement and COMMIT errors', t => {
  const original = DatabaseSync.prototype.exec;
  for (const sql of ['BEGIN', 'COMMIT']) {
    for (const errcode of [5, 261, 10]) {
      const store = open();
      const fault = Object.assign(new Error('injected SQLite fault'), { errcode });
      const exec = t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, input: string) {
        if (input === sql) throw fault;
        return original.call(this, input);
      });
      try { assert.throws(() => store.read(), { code: errcode % 256 === 5 ? 'busy' : 'runs_unavailable', status: errcode % 256 === 5 ? 409 : 503 }); }
      finally { exec.mock.restore(); store.close(); }
    }
  }
  const store = open();
  try {
    inspect(db => db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END"));
    assert.throws(() => store.write(tx => createFixtureRun(store, tx, fields(), 'failed insert')), { code: 'runs_unavailable', status: 503 });
    assert.deepEqual(store.read(), []);
  } finally { store.close(); }
});

// Requests need their placement row (foreign key); Runs name the same placement and Task.
function placeTestPerson(db: DatabaseSync, placementId = 'Ptest', taskId = firstTask, responsible = 0): void {
  db.prepare("INSERT OR IGNORE INTO agents(id, created_at) VALUES ('A1', ?)").run(time);
  db.prepare(`INSERT INTO placements(id, task_id, agent_id, profile_key, responsible, revision, started_at)
    VALUES (?, ?, 'A1', 'fake', ?, 1, ?)`).run(placementId, taskId, responsible, time);
}
const newRequest = (id: string, overrides: Partial<NewRequest> = {}): NewRequest => ({ id, taskId: firstTask, placementId: 'Ptest',
  placementRevision: 1, taskHash: '0'.repeat(64), waitCycleId: null, headRunId: null, aboutRunId: null, mode: 'new', body: 'work', purpose: 'instruction',
  author: { kind: 'human' }, submittedAt: time, deliveryState: 'queued', ...overrides });

test('Request values are refused on write and a stored broken value fails the read instead of being reinterpreted', () => {
  open().close();
  inspect(db => placeTestPerson(db));
  const store = open();
  try {
    // The CHECK constraints refuse the enumerated columns; the store refuses an author that is not an actor.
    for (const broken of [{ mode: 'sideways' }, { purpose: 'nobody' }, { deliveryState: 'whatever' }] as unknown as Partial<NewRequest>[])
      assert.throws(() => store.write(tx => tx.insertRequest(newRequest('broken', broken))), { code: 'runs_unavailable' });
    for (const author of ['not json', { kind: 'placement' }, { kind: 'robot' }] as unknown as NewRequest['author'][])
      assert.throws(() => store.write(tx => tx.insertRequest(newRequest('broken', { author }))), { name: 'ZodError' });
    assert.deepEqual(store.readRequests(), []);
    store.write(tx => tx.insertRequest(newRequest('kept', { mode: 'continue', purpose: 'instruction', author: { kind: 'main', provider: 'codex', conversationId: 'c1' } })));
    assert.deepEqual(store.getRequest('kept'), { ...newRequest('kept', { mode: 'continue', purpose: 'instruction',
      author: { kind: 'main', provider: 'codex', conversationId: 'c1' } }), answersQuestion: null, runId: null });
    assert.throws(() => inspect(db => db.prepare("UPDATE requests SET mode='new' WHERE id='kept'").run()), /immutable/);
    // Deliberately bypass the immutable guard only in this corruption fixture.
    inspect(db => db.exec('DROP TRIGGER requests_immutable'));
    // A value written around the store is not silently read as another value.
    for (const [column, value] of [['mode', 'sideways'], ['author', 'not json'], ['author', '{"kind":"robot"}'], ['purpose', 'nobody']]) {
      // The canonical author's JSON index rejects malformed bytes even when CHECKs are bypassed.
      // Valid JSON with an invalid actor still reaches (and must fail) the repository's read codec below.
      if (column === 'author' && value === 'not json') {
        assert.throws(() => inspect(db => {
          db.exec('PRAGMA ignore_check_constraints = ON');
          db.prepare("UPDATE requests SET author=? WHERE id='kept'").run(value);
        }), /malformed JSON/);
        assert.deepEqual(store.getRequest('kept')!.author, { kind: 'main', provider: 'codex', conversationId: 'c1' });
        continue;
      }
      inspect(db => {
        db.exec('PRAGMA ignore_check_constraints = ON');
        db.prepare(`UPDATE requests SET ${column} = ? WHERE id = 'kept'`).run(value);
      });
      assert.throws(() => store.readRequests(), { code: 'runs_unavailable' });
      assert.throws(() => store.getRequest('kept'), { code: 'runs_unavailable' });
      inspect(db => db.prepare(`UPDATE requests SET ${column} = ? WHERE id = 'kept'`)
        .run(column === 'mode' ? 'continue' : column === 'purpose' ? 'instruction' : '{"kind":"main","provider":"codex","conversationId":"c1"}'));
    }
    assert.equal(store.getRequest('kept')?.mode, 'continue');
  } finally { store.close(); }
});

test('a Request names its Run only through the Run record; relation reads use their indexes', () => {
  open().close();
  inspect(db => { placeTestPerson(db); placeTestPerson(db, 'Pother', secondTask); });
  const store = open();
  try {
    inspect(db => assert.equal((db.prepare('PRAGMA table_info(requests)').all() as { name: string }[])
      .some(column => column.name === 'run_id'), false));
    const [first, aborted, plain, other] = store.write(tx => {
      tx.insertRequest(newRequest('first'));
      const first = createFixtureRun(store, tx, fields({ requestId: 'first' }), 'first');
      tx.insertRequest(newRequest('aborted'));
      const aborted = createFixtureRun(store, tx, fields({ requestId: 'aborted' }), 'aborted');
      tx.update({ ...aborted, state: 'cancelled', reason: 'stopped', ended_at: time });
      tx.updateRequest('aborted', 'aborted');
      const plain = createFixtureRun(store, tx, fields(), 'no request');
      const other = createFixtureRun(store, tx, fields({ task: secondTask, placementId: 'Pother' }), 'other placement');
      return [first, aborted, plain, other];
    });
    assert.equal(store.getRequest('first')?.runId, first.id);
    assert.deepEqual(store.readRequests().filter(request => ['aborted', 'first'].includes(request.id))
      .map(request => [request.id, request.runId]), [['aborted', aborted.id], ['first', first.id]]);
    // One Request admits at most one Run.
    assert.throws(() => store.write(tx => createFixtureRun(store, tx, fields({ requestId: 'first' }), 'second run')), { code: 'runs_unavailable' });
    // Changing the delivery state leaves the Request's Run where the Run record put it.
    assert.throws(() => store.write(tx => tx.updateRequest('missing', 'waiting_for_run')), { code: 'not_found' });
    store.write(tx => tx.updateRequest('first', 'waiting_for_run'));
    assert.deepEqual([store.getRequest('first')?.deliveryState, store.getRequest('first')?.runId], ['waiting_for_run', first.id]);
    assert.deepEqual(store.conversationRuns('Ptest').map(run => run.id), [first.id, plain.id]);
    assert.deepEqual(store.write(tx => tx.conversationRuns('Ptest')).map(run => run.id), [first.id, plain.id]);
    assert.equal(store.conversationHead('Ptest')?.id, plain.id);
    assert.equal(store.conversationHead('Pother')?.id, other.id);
    assert.equal(store.conversationHead('Pmissing'), null);
    assert.deepEqual(store.write(tx => tx.runsOfTask(firstTask)).map(run => run.id), [first.id, aborted.id, plain.id]);
    assert.deepEqual(store.write(tx => tx.runsOfTask(secondTask)).map(run => run.id), [other.id]);
    const latest = store.write(tx => {
      tx.insertRequest(newRequest('latest'));
      return createFixtureRun(store, tx, fields({ requestId: 'latest' }), 'latest');
    });
    assert.equal(store.conversationHead('Ptest')?.id, latest.id);
    assert.equal(store.write(tx => tx.conversationHead('Ptest', 'latest'))?.id, plain.id);
    inspect(db => {
      for (const [index, where] of [['runs_task', 'task_id'], ['runs_placement', 'placement_id'],
        ['runs_request', 'request_id'], ['runs_conversation', 'conversation_id']]) {
        const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM runs WHERE ${where} = ?`).all('x') as { detail: string }[])
          .map(row => row.detail).join(' ');
        assert.match(plan, new RegExp(`USING (COVERING )?INDEX (?:${index}|sqlite_autoindex_runs_[0-9]+)\\b`));
      }
    });
  } finally { store.close(); }
});

test('success cannot bypass atomic reply commit, and a final reply is immutable', () => {
  const store = open();
  try {
    const run = store.write(tx => {
      const run = createFixtureRun(store, tx, fields(), 'frozen prompt');
      tx.update({ ...run, state: 'running', started_at: time });
      return tx.get(run.id)!;
    });
    const ended = { ...run, state: 'succeeded' as const, ended_at: time };
    assert.throws(() => store.write(tx => tx.update(ended)), /final reply/);
    assert.equal(store.get(run.id)?.state, 'running');
    assert.throws(() => store.write(tx => tx.finish(ended, { state: 'missing', text: null })), /valid final reply/);
    assert.throws(() => store.write(tx => {
      tx.finish(ended, { state: 'present', text: 'not committed' });
      throw new Error('abort finish');
    }), /abort finish/);
    assert.equal(store.getText(run.id)?.resultState, 'pending');
    store.write(tx => tx.finish(ended, { state: 'present', text: 'final' }));
    assert.throws(() => store.write(tx => tx.finish(ended, { state: 'present', text: 'replacement' })), /twice/);
    store.write(tx => tx.update({ ...ended, stop_requested: true }));
    assert.equal(store.getText(run.id)?.result, 'final');
    assert.equal(store.getText(run.id)?.prompt, 'frozen prompt');
  } finally { store.close(); }
});

test('the periodic checks read the Runs not yet ended, not the ended history', () => {
  const store = open();
  try {
    store.write(tx => {
      const done = createFixtureRun(store, tx, fields(), 'done');
      tx.update({ ...done, state: 'running', started_at: time });
      tx.update({ ...done, state: 'failed', reason: 'launch', ended_at: time });
      const going = createFixtureRun(store, tx, fields(), 'going');
      tx.update({ ...going, state: 'running', started_at: time });
      createFixtureRun(store, tx, fields(), 'waiting');
    });
    assert.deepEqual(store.readUnfinished().map(run => [run.id, run.state]), [['R2', 'running'], ['R3', 'queued']]);
    assert.equal(store.read().length, 3);
  } finally { store.close(); }
});

/** The open coordinator conversation, as the screen's conversation opens it. */
function openConversation(): string {
  const id = randomUUID();
  inspect(db => db.prepare('INSERT INTO coordinator_conversations(id, started_at) VALUES (?, ?)').run(id, time));
  return id;
}
/** A message to the coordinator conversation and the coordinator Run queued to answer it. */
function message(tx: RunTransaction, conversationId: string, extra: Partial<CreateCoordinatorRunFields> = {}) {
  const requestId = randomUUID();
  tx.insertConversationRequest({ id: requestId, conversationId, headRunId: null, mode: 'new', body: 'message', submittedAt: time,
    deliveryState: 'queued' });
  return tx.createCoordinatorRun(coordinatorFields({ conversationId, requestId, ...extra }), 'message');
}

test('a coordinator Run and its message stay out of every Task-side read; only the execution layer reads them', () => {
  const conversationId = openConversation();
  const store = open();
  try {
    const [task, coordinator] = store.write(tx => [createFixtureRun(store, tx, fields(), 'task work'), message(tx, conversationId)] as const);
    assert.deepEqual(store.read().map(run => run.id), [task.id, coordinator.id]);
    assert.deepEqual(store.readUnfinished().map(run => run.id), [task.id, coordinator.id]);
    assert.equal(store.runtimeGet(coordinator.id)?.role, 'coordinator');
    assert.equal(store.get(coordinator.id), null);
    assert.equal(store.credentialOf(coordinator.id), null);
    assert.equal(store.credentialOf(task.id)?.run.id, task.id);
    assert.equal(store.getRequest(coordinator.requestId), null);
    assert.deepEqual(store.readRequests().map(request => request.id), [task.requestId]);
    const snapshot = store.snapshot();
    assert.deepEqual(snapshot.records?.map(run => run.id), [task.id]);
    assert.deepEqual(snapshot.requests.map(request => request.id), [task.requestId]);
    store.write(tx => {
      assert.deepEqual(tx.all().map(run => run.id), [task.id]);
      assert.deepEqual(tx.requests().map(request => request.id), [task.requestId]);
      assert.equal(tx.get(coordinator.id), null);
      assert.equal(tx.getRequest(coordinator.requestId), null);
      assert.equal(tx.runtimeGet(coordinator.id)?.id, coordinator.id);
      assert.deepEqual(tx.forSettle().map(run => run.id), [task.id, coordinator.id]);
    });
  } finally { store.close(); }
});

test('the conversation\'s Runs leave out withdrawn messages and its head joined Runs too; a message is fixed with its Run', () => {
  const conversationId = openConversation();
  const store = open();
  try {
    const [working, withdrawn, joined, latest] = store.write(tx => {
      const working = message(tx, conversationId);
      tx.update({ ...working, state: 'running', started_at: time });
      const withdrawn = message(tx, conversationId);
      tx.abortRequest(withdrawn, withdrawn.requestId);
      const joined = message(tx, conversationId);
      tx.update({ ...joined, state: 'joined', into: working.id, ended_at: time });
      return [working, withdrawn, joined, message(tx, conversationId)];
    });
    assert.equal(store.runtimeGet(withdrawn.id)?.state, 'cancelled');
    assert.deepEqual(store.coordinatorRuns(conversationId).map(run => run.id), [working.id, joined.id, latest.id]);
    assert.equal(store.coordinatorHead(conversationId)?.id, latest.id);
    assert.equal(store.coordinatorHead(conversationId, latest.requestId)?.id, working.id);
    assert.equal(store.write(tx => tx.coordinatorHead(conversationId, latest.requestId))?.id, working.id);
    assert.deepEqual(store.coordinatorRuns(randomUUID()), []);
    // What the screen sent and the conversation are the Run's creation fields.
    for (const change of [{ message: { ...latest.message, context: firstTask } }, { conversationId: randomUUID() }])
      assert.throws(() => store.write(tx => tx.update({ ...latest, ...change })), { code: 'conflict' }, JSON.stringify(change));
    store.write(tx => tx.setJoinRequested(latest.id));
    const marked = store.runtimeGet(latest.id);
    assert.ok(marked?.role === 'coordinator');
    assert.equal(marked.joinRequested, true);
    // Only a coordinator Run is sent into the Run working in its conversation.
    const task = store.write(tx => createFixtureRun(store, tx, fields(), 'task work'));
    assert.throws(() => store.write(tx => tx.setJoinRequested(task.id)), { code: 'not_found' });
    assert.deepEqual(store.get(task.id), task);
  } finally { store.close(); }
});

test('a session is a Task Run\'s before it is the coordinator conversation\'s latest Run\'s, or nobody\'s', () => {
  const conversationId = openConversation();
  const store = open();
  try {
    const latest = store.write(tx => {
      createFixtureRun(store, tx, fields({ session: { provider: 'claude', id: 'shared' } }), 'task work');
      message(tx, conversationId, { session: { provider: 'claude', id: 'shared' } });
      message(tx, conversationId, { session: { provider: 'claude', id: 'coordinator' } });
      return message(tx, conversationId, { session: { provider: 'claude', id: 'coordinator' } });
    });
    assert.deepEqual(store.sessionOwner(['coordinator']), { coordinator: conversationId, runId: latest.id });
    assert.equal(store.sessionOwner(['shared']), 'task_run');
    assert.equal(store.sessionOwner(['coordinator', 'shared']), 'task_run');
    assert.equal(store.sessionOwner(['unknown']), null);
  } finally { store.close(); }
});

test('a list read names the project whose own rows it reads, a nested project\'s apart; without one it reads them all', async () => {
  const commands = new ControlTaskCommands(area, { kind: 'human' });
  const nested = (await commands.create({ kind: 'project', color: '#39659b', parentId: project, userRequested: null,
    tasks: [{ title: 'Nested' }] })).tasks[0].id;
  const nestedTask = (await commands.create({ parentId: nested, userRequested: false, tasks: [{ title: 'Nested work' }] })).tasks[0].id;
  inspect(db => { placeTestPerson(db, 'Pfirst', firstTask, 1); placeTestPerson(db, 'Pnested', nestedTask, 1); });
  // Moving work under a Task tells that parent: one return in each project.
  for (const parentId of [firstTask, nestedTask]) {
    const child = (await commands.create({ parentId: parentId === firstTask ? project : nested,
      userRequested: true, tasks: [{ title: 'Incoming' }] })).tasks[0];
    await commands.move({ id: child.id, parentId, expectedTaskHash: child.hash });
  }
  const store = open();
  try {
    const [projectRun, nestedRun] = store.write(tx => [createFixtureRun(store, tx, fields({ placementId: 'Pfirst' }), 'work'),
      createFixtureRun(store, tx, fields({ task: nestedTask, placementId: 'Pnested' }), 'nested work')] as const);
    const read = (scope?: string) => {
      const snapshot = store.snapshot(scope);
      return {
        runs: store.write(tx => tx.all(scope)).map(run => run.id), snapshot: snapshot.records?.map(run => run.id),
        placements: snapshot.placements.map(placement => placement.id),
        responsible: store.write(tx => tx.responsiblePlacements(scope)).map(placement => placement.id).sort(),
        requests: store.readRequests(scope).map(request => request.taskId).sort(),
        returns: store.readReturns(scope).map(row => `${row.outcome} ${row.toTaskId}`).sort(),
      };
    };
    assert.deepEqual(read(project), { runs: [projectRun.id], snapshot: [projectRun.id], placements: ['Pfirst'],
      responsible: ['Pfirst'], requests: [firstTask], returns: [`work_changed ${firstTask}`] });
    assert.deepEqual(read(nested), { runs: [nestedRun.id], snapshot: [nestedRun.id], placements: ['Pnested'],
      responsible: ['Pnested'], requests: [nestedTask], returns: [`work_changed ${nestedTask}`] });
    assert.deepEqual(read(), { runs: [projectRun.id, nestedRun.id], snapshot: [projectRun.id, nestedRun.id],
      placements: ['Pfirst', 'Pnested'], responsible: ['Pfirst', 'Pnested'], requests: [firstTask, nestedTask].sort(),
      returns: [`work_changed ${firstTask}`, `work_changed ${nestedTask}`].sort() });
    // Destination reads retain the caller's project boundary and never load another seat's returns.
    assert.deepEqual(store.readReturnsForTask(firstTask), store.readReturns(project));
    assert.deepEqual(store.readReturnsForTask(nestedTask, project), []);
    assert.deepEqual(store.readReturnsForTask(nestedTask, nested), store.readReturns(nested));
    const scoped = store.snapshot(undefined, [firstTask]);
    assert.deepEqual(scoped.records?.map(run => run.id), [projectRun.id]);
    assert.deepEqual(scoped.placements.map(placement => placement.id), ['Pfirst']);
    assert.deepEqual(scoped.requests.map(request => request.taskId), [firstTask]);
    assert.deepEqual(scoped.returns.map(row => row.toTaskId), [firstTask]);
    assert.deepEqual(store.snapshot(nested, [firstTask]).records, []);
    assert.deepEqual(store.snapshot(undefined, []).returns, []);
    store.write(tx => {
      assert.deepEqual(tx.all(undefined, [firstTask]).map(run => run.id), [projectRun.id]);
      assert.deepEqual(tx.requests(undefined, [firstTask]).map(request => request.taskId), [firstTask]);
      assert.deepEqual(tx.returns(undefined, [firstTask]).map(row => row.toTaskId), [firstTask]);
      assert.deepEqual(tx.responsiblePlacements(undefined, [firstTask]).map(placement => placement.id), ['Pfirst']);
      assert.deepEqual(tx.all(undefined, []), []);
      assert.deepEqual(tx.requests(nested, [firstTask]), []);
    });
  } finally { store.close(); }
});

test('a subtree\'s unfinished Runs are its Task Runs not yet ended, in Run order, but the one named', () => {
  const conversationId = openConversation();
  const store = open();
  try {
    const [running, queued] = store.write(tx => {
      const running = createFixtureRun(store, tx, fields(), 'running');
      tx.update({ ...running, state: 'running', started_at: time });
      const failed = createFixtureRun(store, tx, fields(), 'failed');
      tx.update({ ...failed, state: 'running', started_at: time });
      tx.update({ ...failed, state: 'failed', reason: 'exit', started_at: time, ended_at: time });
      message(tx, conversationId);
      return [running, createFixtureRun(store, tx, fields({ task: secondTask, placementId: 'Psecond' }), 'queued')];
    });
    store.write(tx => {
      assert.deepEqual(tx.unfinishedIn([firstTask, secondTask]), [running.id, queued.id]);
      assert.deepEqual(tx.unfinishedIn([firstTask, secondTask], running.id), [queued.id]);
      assert.deepEqual(tx.unfinishedIn([secondTask]), [queued.id]);
      assert.deepEqual(tx.unfinishedIn([]), []);
    });
  } finally { store.close(); }
});

test('admission reads the caller ancestry and all direct children across Tasks, including completed children', () => {
  const store = open();
  try {
    store.write(tx => {
      const ancestor = createFixtureRun(store, tx, fields(), 'ancestor');
      const caller = createFixtureRun(store, tx, fields({ task: secondTask, placementId: 'Padmission', caller: { run: ancestor.id } }), 'caller');
      const child = createFixtureRun(store, tx, fields({ caller: { run: caller.id } }), 'completed child');
      tx.update({ ...child, state: 'cancelled', reason: 'stopped', ended_at: time });
      const sibling = createFixtureRun(store, tx, fields({ task: secondTask, placementId: 'Padmission', caller: { run: caller.id } }), 'sibling Task child');
      createFixtureRun(store, tx, fields({ caller: { run: ancestor.id } }), 'another caller branch');
      createFixtureRun(store, tx, fields(), 'unrelated history');
      const admission = tx.forAdmission(caller.id);
      assert.deepEqual(admission.map(run => run.id), [ancestor.id, caller.id, child.id, sibling.id]);
      assert.equal(admission.find(run => run.id === child.id)?.state, 'cancelled');
      // Return facts close upward over historical Run references without widening the ordinary Task read.
      assert.deepEqual(tx.all(undefined, [secondTask]).map(run => run.id), [caller.id, sibling.id]);
      assert.deepEqual(tx.returnRuns(undefined, [secondTask]).map(run => run.id), [ancestor.id, caller.id, sibling.id]);
      assert.deepEqual(tx.returnRuns(undefined, []), []);
      assert.deepEqual(tx.forAdmission(), []);
    });
  } finally { store.close(); }
});
