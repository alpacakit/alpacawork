import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { completeSkillsReceiptSchema, InstalledSkillsStore, MANAGED_SKILL_NAMES, BUNDLED_SKILL_NAMES,
  SkillsRefused, type ManagedSkillName, type SkillInstallSession } from '@alpacawork/core/installed-skills';

/** Synthetic skill source; acquisition and distribution verification belong to a different owner. */
function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'installed-skills-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, 'distribution'), skills = join(root, 'home/.agents/skills');
  mkdirSync(release, { recursive: true }); mkdirSync(skills, { recursive: true, mode: 0o700 });
  writeFileSync(join(release, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  for (const name of MANAGED_SKILL_NAMES) {
    const target = join(release, 'skills', name);
    mkdirSync(join(target, 'empty'), { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), `# ${name}\nSee reference.md.\n`);
    writeFileSync(join(target, 'reference.md'), `content for ${name}\n`);
  }
  const store = new InstalledSkillsStore(skills);
  const place = (name: ManagedSkillName) => cpSync(join(release, 'skills', name), join(skills, name), { recursive: true });
  const install = async (selected: ManagedSkillName[]) => store.session(session => {
    session.begin({ operationId: randomUUID(), place: selected, remove: [], release });
    for (const name of selected) place(name);
    return session.commit();
  });
  return { root, release, skills, store, place, install };
}

test('basic-only installation records only its request and package version', async t => {
  const f = fixture(t);
  assert.equal(f.store.read(), null); assert.equal(existsSync(join(f.skills, '.alpacawork')), false);
  const receipt = await f.install(['alpacawork']);
  assert.deepEqual(receipt.skills.map(skill => skill.name), ['alpacawork']);
  assert.deepEqual(receipt, { version: 2, state: 'complete', operationId: receipt.operationId,
    request: { release: f.release, place: ['alpacawork'], remove: [] },
    skills: [{ name: 'alpacawork', source: { version: '1.2.3' } }] });
  assert.deepEqual(f.store.read(), { receipt });
  assert.deepEqual(readdirSync(join(f.skills, '.alpacawork')).sort(), ['install.lock', 'installed.json']);
  assert.deepEqual(readdirSync(f.skills).sort(), ['.alpacawork', 'alpacawork']);
});

test('adding a chosen addon preserves the edited basic skill and its original installation facts', async t => {
  const f = fixture(t), base = await f.install(['alpacawork']);
  writeFileSync(join(f.skills, 'alpacawork/SKILL.md'), '# user edited basic\n');
  const after = await f.install(['alpacawork-betterquality']);
  assert.deepEqual(after.skills[0], base.skills[0]);
  assert.deepEqual(after.skills.map(skill => skill.name), ['alpacawork', 'alpacawork-betterquality']);
  assert.equal(readFileSync(join(f.skills, 'alpacawork/SKILL.md'), 'utf8'), '# user edited basic\n');
});

test('unselected addon existence never changes the selected installation', async t => {
  const f = fixture(t); await f.install(['alpacawork']); f.place('alpacawork-majority');
  assert.deepEqual(f.store.read()!.receipt.skills.map(skill => skill.name), ['alpacawork']);
});

test('a process exit retains the intended version table, and a new command can finish it', async t => {
  const f = fixture(t), previous = await f.install(['alpacawork']), operationId = randomUUID();
  const script = `import { InstalledSkillsStore } from '@alpacawork/core/installed-skills';
    await new InstalledSkillsStore(process.argv[1]).session(s => {
      s.begin({ operationId: process.argv[2], place: ['alpacawork-betterquality'], remove: [], release: process.argv[3] });
      process.exit(0);
    });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.skills, operationId, f.release],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  const interrupted = f.store.read()!.receipt;
  assert.equal(interrupted.state, 'installing');
  if (interrupted.state !== 'installing') return;
  assert.equal('previous' in interrupted, false);
  assert.deepEqual(interrupted.skills[0], previous.skills[0]);
  assert.deepEqual(interrupted.skills.map(skill => skill.name), ['alpacawork', 'alpacawork-betterquality']);
  const next = await f.store.session(s => {
    s.begin({ operationId: randomUUID(), place: ['alpacawork-betterquality'], remove: [], release: f.release });
    f.place('alpacawork-betterquality'); return s.commit();
  });
  assert.deepEqual(next.skills[0], previous.skills[0]);
  assert.notEqual(next.operationId, operationId);
});

test('session handles expire and expose copies of their metadata', async t => {
  const f = fixture(t); await f.install(['alpacawork']);
  let retained: SkillInstallSession;
  await f.store.session(s => {
    retained = s;
    const current = s.current!;
    current.receipt.operationId = randomUUID();
    assert.notDeepEqual(current, s.current);
    s.begin({ operationId: randomUUID(), place: ['alpacawork-betterquality'], remove: [], release: f.release });
    f.place('alpacawork-betterquality');
    const complete = s.commit(); complete.operationId = randomUUID();
    assert.notDeepEqual(complete, s.current!.receipt);
  });
  assert.throws(() => retained!.begin({operationId:randomUUID(),place:['alpacawork'],remove:[],release:f.release}), /session has ended/);
  assert.equal(f.store.read()!.receipt.state, 'complete');
});

test('receipt corruption, duplicate JSON keys, unknown fields, and missing lock are refused without repair', async t => {
  const f = fixture(t); await f.install(['alpacawork']);
  const path = join(f.skills, '.alpacawork/installed.json'), bytes = readFileSync(path);
  for (const input of [Buffer.from([0xff]), Buffer.from('{"version":2,"version":2}'),
    Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), version: 1 })),
    Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), injected: true }))]) {
    writeFileSync(path, input);
    assert.throws(() => f.store.read(), error => error instanceof SkillsRefused);
    assert.deepEqual(readFileSync(path), input);
  }
  writeFileSync(path, bytes); rmSync(join(f.skills, '.alpacawork/install.lock'));
  assert.throws(() => f.store.read(), error => error instanceof SkillsRefused);
  assert.equal(existsSync(join(f.skills, '.alpacawork/install.lock')), false);
});

test('ordinary metadata reads follow file links, while schema rejects a base-free or duplicated selection', async t => {
  const f = fixture(t), receipt = await f.install(['alpacawork']);
  const path = join(f.skills, '.alpacawork/installed.json');
  cpSync(path, join(f.root, 'other.json')); rmSync(path); symlinkSync(join(f.root, 'other.json'), path);
  assert.deepEqual(f.store.read()?.receipt, receipt);
  const link = join(f.root, 'linked-root'); symlinkSync(f.skills, link);
  assert.deepEqual(new InstalledSkillsStore(link).read()?.receipt, receipt);
  assert.equal(completeSkillsReceiptSchema.safeParse({ ...receipt, skills: [] }).success, false);
  assert.equal(completeSkillsReceiptSchema.safeParse({ ...receipt, skills: [receipt.skills[0], receipt.skills[0]] }).success, false);
});

// Builtin ESM hooks observe the real store and real filesystem without a production adapter.
const inode = (info: { dev: number | bigint; ino: number | bigint }) => `${info.dev}:${info.ino}`;
test('a flush fault after atomic complete publication propagates and explicit retry succeeds', async t => {
  const f = fixture(t), operationId = randomUUID(), fault = errno('injected flush fault');
  let injected = false;
  await assert.rejects(f.store.session(s => {
    s.begin({ operationId, place: ['alpacawork'], remove: [], release: f.release }); f.place('alpacawork');
    const control = inode(fs.statSync(join(f.skills, '.alpacawork'))), originalSync = fs.fsyncSync;
    const hook = t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (inode(fs.fstatSync(fd)) === control) { injected = true; throw fault; }
      return originalSync(fd);
    });
    syncBuiltinESMExports();
    try { return s.commit(); }
    finally { hook.mock.restore(); syncBuiltinESMExports(); }
  }), error => error === fault);
  assert.equal(injected, true);
  assert.equal(f.store.read()!.receipt.state, 'complete');
  await f.store.session(s => assert.equal(s.begin({ operationId, place: ['alpacawork'], remove: [], release: f.release })?.state, 'complete'));
});

test('receipt publication never reads saved bytes back', async t => {
  const f = fixture(t);
  await f.store.session(s => {
    s.begin({ operationId: randomUUID(), place: ['alpacawork'], remove: [], release: f.release }); f.place('alpacawork');
    const hook = t.mock.method(fs, 'readFileSync', () => { throw new Error('unexpected readback'); });
    syncBuiltinESMExports();
    try { assert.equal(s.commit().state, 'complete'); }
    finally { hook.mock.restore(); syncBuiltinESMExports(); }
  });
});

test('the bundled name definition matches the distributed skills', () => {
  const names = readdirSync(new URL('../skills', import.meta.url)).filter(name => name === 'alpacawork' || name.startsWith('alpacawork-')).sort();
  assert.deepEqual([...BUNDLED_SKILL_NAMES], names);
});

for (const code of [null, 'ENOENT', 'ENOSPC'] as const) {
  test(`installer callback failure retains its original cause (${code ?? 'custom error'})`, async t => {
    const f = fixture(t), operationId = randomUUID();
    const original = Object.assign(new Error('injected installer copy failure'), code ? { code, syscall: 'copyfile' } : {});
    await assert.rejects(f.store.session(s => {
      s.begin({ operationId, place: ['alpacawork'], remove: [], release: f.release }); throw original;
    }), error => error === original);
    assert.equal(f.store.read()!.receipt.state, 'installing');
  });
}

test('failed temporary cleanup retains both the publication fault and the cleanup fault', async t => {
  const f = fixture(t), original = Object.assign(new Error('injected receipt write failure'), { code: 'ENOSPC' });
  await assert.rejects(f.store.session(s => {
    s.begin({ operationId: randomUUID(), place: ['alpacawork'], remove: [], release: f.release }); f.place('alpacawork');
    const control = join(f.skills, '.alpacawork'), originalSync = fs.fsyncSync;
    let injected = false;
    const hook = t.mock.method(fs, 'fsyncSync', (fd: number) => {
      const temporary = readdirSync(control).find(name => name.startsWith('receipt-') && name.endsWith('.tmp'));
      if (!injected && temporary && inode(fs.fstatSync(fd)) === inode(fs.statSync(join(control, temporary)))) {
        injected = true;
        // Replacing only this test's temporary entry with a directory makes unlinkat fail.
        rmSync(join(control, temporary)); mkdirSync(join(control, temporary)); throw original;
      }
      return originalSync(fd);
    });
    syncBuiltinESMExports();
    try { return s.commit(); }
    finally { hook.mock.restore(); syncBuiltinESMExports(); }
  }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, original); assert.equal(error.errors[0], original);
    assert.ok(['EISDIR', 'EPERM'].includes(error.errors[1].code));
    return true;
  });
  assert.equal(f.store.read()!.receipt.state, 'installing');
});

/** Preserve the actual error objects, including through nested resource scopes. */
function failureLeaves(error: unknown): unknown[] {
  if (error instanceof AggregateError) return error.errors.flatMap(failureLeaves);
  return [error];
}
function assertFailureOrder(error: unknown, expected: readonly unknown[]) {
  const actual = failureLeaves(error); assert.equal(actual.length, expected.length);
  expected.forEach((cause, index) => assert.equal(actual[index], cause, `original cause identity at index ${index}`));
}
function errno(message: string, code = 'EIO') { return Object.assign(new Error(message), { code }); }

for (const api of ['read', 'session'] as const) for (const primaryFailure of [false, true]) {
  test(`${api} retains ${primaryFailure ? 'operation and' : 'standalone'} cleanup failures and closes siblings`, async t => {
    const f = fixture(t); await f.install(['alpacawork']);
    const keys = new Map([
      [inode(fs.statSync(join(f.skills, '.alpacawork'))), 'directory'],
      [inode(fs.statSync(join(f.skills, '.alpacawork/install.lock'))), 'lock'],
    ]);
    const receiptKey = inode(fs.statSync(join(f.skills, '.alpacawork/installed.json')));
    const held = new Map<string, number>(), cleanup: Error[] = [], closed: number[] = [];
    const original = errno('original operation', 'ENOSPC');
    const actualStat = fs.fstatSync, actualClose = fs.closeSync, actualRead = fs.readSync;
    let armed = api === 'read' && !primaryFailure, readFault = false, observed: unknown;
    const statHook = t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
      const info = Reflect.apply(actualStat, fs, args), label = keys.get(inode(info));
      if (label && !held.has(label)) held.set(label, args[0]);
      return info;
    });
    const closeHook = t.mock.method(fs, 'closeSync', (fd: number) => {
      const label = keys.get(inode(actualStat(fd))); actualClose(fd);
      if (armed && label) {
        closed.push(fd); const error = errno(`${label} cleanup`); cleanup.push(error); throw error;
      }
    });
    const readHook = t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
      if (api === 'read' && primaryFailure && inode(actualStat(args[0])) === receiptKey) {
        readFault = true; armed = true; throw original;
      }
      return Reflect.apply(actualRead, fs, args);
    });
    syncBuiltinESMExports();
    try {
      if (api === 'read') f.store.read();
      else await f.store.session(s => {
        s.begin({ operationId: randomUUID(), place: ['alpacawork-betterquality'], remove: [], release: f.release });
        if (!primaryFailure) { f.place('alpacawork-betterquality'); s.commit(); }
        armed = true; if (primaryFailure) throw original;
      });
    } catch (error) { observed = error; }
    finally { statHook.mock.restore(); closeHook.mock.restore(); readHook.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(cleanup.length, api === 'read' ? 1 : 2, 'every targeted close was reached');
    assert.deepEqual(cleanup.map(error => error.message), api === 'read' ? ['directory cleanup'] : ['lock cleanup', 'directory cleanup']);
    assert.equal(readFault, api === 'read' && primaryFailure);
    for (const fd of closed) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
    assert.ok(observed instanceof AggregateError);
    assert.equal('code' in observed, false);
    assertFailureOrder(observed, [...(primaryFailure ? [original] : []), ...cleanup]);
    assert.equal(f.store.read()!.receipt.state, api === 'session' && primaryFailure ? 'installing' : 'complete');
    // Failed closes were really closed by the hook: a fresh writer must enter without waiting.
    await f.store.session(() => {});
  });
}

test('a failed publication retains its exact primary error plus both session close failures', async t => {
  const f = fixture(t), syncFault = errno('published directory fsync'), closeFaults = [errno('lock close'), errno('directory close')];
  const keys = new Map([
    [inode(fs.statSync(f.skills)), 'root'],
  ]);
  const actualClose = fs.closeSync, actualSync = fs.fsyncSync;
  let armed = false, syncReached = false, primary: unknown, observed: unknown;
  const injected: Error[] = [], closed: number[] = [];
  const closeHook = t.mock.method(fs, 'closeSync', (fd: number) => {
    const stat = fs.fstatSync(fd), key = inode(stat); actualClose(fd);
    if (armed && keys.get(key) === 'lock' && !injected.includes(closeFaults[0]!)) {
      closed.push(fd); injected.push(closeFaults[0]!); throw closeFaults[0];
    }
    if (armed && keys.get(key) === 'directory' && !injected.includes(closeFaults[1]!)) {
      closed.push(fd); injected.push(closeFaults[1]!); throw closeFaults[1];
    }
  });
  const syncHook = t.mock.method(fs, 'fsyncSync', (fd: number) => {
    const key = inode(fs.fstatSync(fd));
    if (keys.get(key) === 'directory' && JSON.parse(readFileSync(join(f.skills, '.alpacawork/installed.json'), 'utf8')).state === 'complete') {
      syncReached = true; armed = true; throw syncFault;
    }
    return actualSync(fd);
  });
  syncBuiltinESMExports();
  try {
    await f.store.session(s => {
      keys.set(inode(fs.statSync(join(f.skills, '.alpacawork/install.lock'))), 'lock');
      keys.set(inode(fs.statSync(join(f.skills, '.alpacawork'))), 'directory');
      s.begin({ operationId: randomUUID(), place: ['alpacawork'], remove: [], release: f.release }); f.place('alpacawork');
      try { s.commit(); } catch (error) { primary = error; throw error; }
    });
  } catch (error) { observed = error; }
  finally { closeHook.mock.restore(); syncHook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(syncReached, true); assert.deepEqual(injected, closeFaults);
  for (const fd of closed) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
  assert.equal(primary, syncFault);
  assert.ok(observed instanceof AggregateError); assert.equal(observed.errors[0], primary);
  assertFailureOrder(observed, [syncFault, ...closeFaults]); assert.equal('code' in observed, false);
  assert.equal(f.store.read()!.receipt.state, 'complete');
  await f.store.session(() => {});
});

test('a caller failure after commit propagates without restoring bytes', async t => {
  const f = fixture(t), original = errno('caller work after commit', 'ENOSPC');
  let observed: unknown;
  try { await f.store.session(s => {
    s.begin({ operationId: randomUUID(), place: ['alpacawork'], remove: [], release: f.release }); f.place('alpacawork');
    s.commit(); throw original;
  }); } catch (error) { observed = error; }
  assert.equal(observed, original);
  assertFailureOrder(observed, [original]); assert.equal(f.store.read()!.receipt.state, 'complete');
});

test('ordinary metadata read preserves the read fault and both file and directory close faults', async t => {
  const f = fixture(t); await f.install(['alpacawork']);
  const receipt = inode(fs.statSync(join(f.skills, '.alpacawork/installed.json'))), directory = inode(fs.statSync(join(f.skills, '.alpacawork')));
  const original = errno('metadata read'), failures: Error[] = [], closed: number[] = [];
  const actualRead = fs.readSync, actualClose = fs.closeSync;
  let armed = false, observed: unknown;
  const readHook = t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    if (inode(fs.fstatSync(args[0])) === receipt) { armed = true; throw original; }
    return Reflect.apply(actualRead, fs, args);
  });
  const closeHook = t.mock.method(fs, 'closeSync', (fd: number) => {
    const key = inode(fs.fstatSync(fd)); actualClose(fd);
    if (armed && [receipt, directory].includes(key)) {
      closed.push(fd); const failure = errno(`nested close ${failures.length}`); failures.push(failure); throw failure;
    }
  });
  syncBuiltinESMExports();
  try { f.store.read(); } catch (error) { observed = error; }
  finally { readHook.mock.restore(); closeHook.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(armed, true); assert.equal(failures.length, 2);
  assertFailureOrder(observed, [original, ...failures]);
  for (const fd of closed) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
  assert.ok(observed instanceof AggregateError); assert.equal(f.store.read()!.receipt.state, 'complete');
});


test('the root writer lock excludes another process and is released after the session', async t => {
  const f = fixture(t); await f.install(['alpacawork']);
  const script = `import { openSync, closeSync } from 'node:fs';
    import { tryLock } from '@alpacawork/core';
    const fd = openSync(process.argv[1], 'r+');
    try { if (tryLock(fd) !== (process.argv[2] === 'free')) process.exitCode = 1; }
    finally { closeSync(fd); }`;
  const check = (state: 'held' | 'free') => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, join(f.skills, '.alpacawork/install.lock'), state],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null);
  };
  await f.store.session(() => check('held'));
  check('free');
});
