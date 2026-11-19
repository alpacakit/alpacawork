/** Release restoration boundaries and edition contracts; cases remain serial within this process. */
/** Switch protocol through its real journal/files, with a local service adapter; systemd is exercised separately. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { failure, platform } from "@alpacawork/core";
import { controlSchemaManifest } from "@alpacawork/db";
import { linkTarget, point } from "@alpacawork/backend/test-dist/release/layout.js";
import { prune, switchTo } from "@alpacawork/backend/test-dist/release/switch.js";
import { CURRENT, setup, diagnosticArtifacts } from './helpers/release-switch-fixture.ts';

test('restoration survives interruption before selection, after selection, and after starting the old serve', async t => {
  for (const boundary of ['before-selection', 'after-selection', 'after-restart'] as const) await t.test(boundary, async t => {
    const h = setup(t, { a: 'f1', b: 'f1' });
    await h.start('a');
    writeFileSync(join(h.releases, 'b', 'broken'), '');
    const restart = platform.service.restart;
    platform.service.restart = service => {
      assert.equal(h.current() !== 'a' || h.journal().phase === 'restoring_old', true);
      const started = restart(service);
      if (h.current() === 'b') {
        // A failed target can leave its connection generation behind. It is stopped before restoration intent.
        const file = join(h.workspace, '.alpacawork/connection.json'), connection = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, JSON.stringify({ ...connection, generation: randomUUID(), runManager: join(h.releases, 'b', 'apps/backend/dist/run-manager.js') }));
      } else if (boundary === 'after-restart') throw new Error('Interrupted restoration');
      return started;
    };
    let subject = switchTo;
    if (boundary !== 'after-restart') {
      const source = new URL('../apps/backend/test-dist/release/switch.js', import.meta.url), code = readFileSync(source, 'utf8');
      const selection = "point(place.releases, 'current', journal.old);";
      const failure = "throw new Error('Interrupted restoration');";
      const interrupted = code.replace(selection, boundary === 'before-selection' ? failure + selection : selection + failure);
      assert.notEqual(interrupted, code, 'the interruption must hit the actual durable selection');
      const resolvable = interrupted.replace(/from (['"])([^'"]+)\1/g, (match, quote: string, specifier: string) =>
        specifier.startsWith('node:') ? match : `from ${quote}${specifier.startsWith('.') ? new URL(specifier, source).href : import.meta.resolve(specifier)}${quote}`);
      const file = join(h.workspace, 'interrupted-restoration.mjs'); writeFileSync(file, resolvable);
      subject = (await import(pathToFileURL(file).href)).switchTo;
    }
    await assert.rejects(subject(h.place, join(h.releases, 'b')), /Interrupted restoration/);
    const pending = h.journal();
    assert.equal(pending.phase, 'restoring_old');
    assert.equal(h.current(), boundary === 'before-selection' ? 'b' : 'a');
    platform.service.restart = restart;
    if (boundary === 'after-restart') await delay(30);
    h.log.length = 0;
    await assert.rejects(switchTo(h.place, join(h.releases, 'b')), /old serve restored/);
    assert.equal(h.current(), 'a');
    assert.equal(h.journal().phase, 'aborted');
    assert.equal(h.journal().opId, pending.opId);
    assert.equal(existsSync(join(h.workspace, 'service-stopped')), false);
    assert.deepEqual(h.log.filter(line => ['drain', 'stop', 'restart'].includes(line)),
      boundary === 'after-restart' ? ['drain', 'stop', 'restart'] : ['stop', 'restart']);
  });
});

test('a restored serve that dies after publishing its generation can resume the same journal', async t => {
  const h = setup(t, { a: 'f1', b: 'f1' }); await h.start('a');
  writeFileSync(join(h.releases, 'b', 'broken'), '');
  const restart = platform.service.restart, restarts = platform.service.restarts;
  let crashed = false;
  platform.service.restarts = service => restarts(service) + (crashed ? 1 : 0);
  platform.service.restart = service => {
    const started = restart(service);
    if (h.current() === 'a') setTimeout(() => { platform.service.stop(service); crashed = true; }, 50);
    return started;
  };
  await assert.rejects(switchTo(h.place, join(h.releases, 'b')), /earlier serve both failed/);
  const pending = h.journal();
  assert.equal(pending.phase, 'restoring_old');
  const connection = JSON.parse(readFileSync(join(h.workspace, '.alpacawork/connection.json'), 'utf8'));
  assert.notEqual(connection.generation, pending.restoreStoppedGeneration, 'the crashed serve published a new generation');
  await assert.rejects(fetch(new URL('/api/runtime/readiness', connection.url)), error =>
    error instanceof TypeError && (error.cause as NodeJS.ErrnoException)?.code === 'ECONNREFUSED');
  platform.service.restart = restart; platform.service.restarts = restarts;
  rmSync(join(h.releases, 'b', 'broken')); h.log.length = 0;
  await assert.rejects(switchTo(h.place, join(h.releases, 'b')), /old serve restored/);
  assert.equal(h.journal().phase, 'aborted'); assert.equal(h.journal().opId, pending.opId);
  assert.equal(h.current(), 'a'); assert.equal(existsSync(join(h.workspace, 'service-stopped')), false);
  assert.deepEqual(h.log.filter(line => ['drain', 'stop', 'restart'].includes(line)), ['stop', 'restart']);
});

test('a prepared switch with a dead replacement generation still requires confirmed service stop', async t => {
  const h = setup(t, { a: 'f1', b: 'f1' }); await h.start('a'); h.state.failStops = true;
  await assert.rejects(switchTo(h.place, join(h.releases, 'b')), /handoff/);
  const pending = h.journal(); assert.equal(pending.phase, 'prepared');
  await h.start('a'); platform.service.stop(h.place.service); await delay(30);
  h.state.failStops = false;
  const stop = platform.service.stop; platform.service.stop = () => false;
  await assert.rejects(switchTo(h.place, join(h.releases, 'b')), /did not stop/);
  assert.equal(h.journal().phase, 'prepared'); assert.equal(h.current(), 'a');
  platform.service.stop = stop; h.log.length = 0;
  assert.equal((await switchTo(h.place, join(h.releases, 'b'))).release, 'b');
  assert.equal(h.journal().phase, 'committed'); assert.equal(h.journal().opId, pending.opId);
  assert.deepEqual(h.log.filter(line => ['drain', 'stop', 'restart'].includes(line)), ['stop', 'restart']);
});

test('a responding serve with refused or invalid drain remains running in both stop paths', async t => {
  for (const phase of ['prepared', 'restoring_old'] as const) for (const blocker of ['failStops', 'invalidStops'] as const)
    await t.test(`${phase}: ${blocker}`, async t => {
      const h = setup(t, { a: 'f1', b: 'f1' }); await h.start('a');
      if (phase === 'restoring_old') {
        writeFileSync(join(h.releases, 'b', 'broken'), '');
        const restart = platform.service.restart;
        platform.service.restart = service => {
          const started = restart(service);
          if (h.current() === 'a') throw new Error('Interrupted after old restart');
          return started;
        };
        await assert.rejects(switchTo(h.place, join(h.releases, 'b')), /Interrupted after old restart/);
        platform.service.restart = restart; await delay(30);
      }
      h.state[blocker] = true; h.log.length = 0;
      await assert.rejects(switchTo(h.place, join(h.releases, 'b')), blocker === 'failStops' ? /handoff/ : /Invalid drained token/);
      assert.equal(h.journal().phase, phase); assert.equal(h.current(), 'a');
      assert.deepEqual(h.log.filter(line => ['drain', 'stop', 'restart'].includes(line)), ['drain']);
      assert.equal(existsSync(join(h.workspace, 'service-stopped')), false);
    });
});

test('same SOURCE editions switch, restore previous without a kind, and prune independently', async t => {
  const sha = 'a'.repeat(40), name = sha + '-diagnostic';
  const h = setup(t, { [sha]: 'f1', [name]: 'f1', unused: 'f1' });
  diagnosticArtifacts(join(h.releases, name), sha);
  await h.start(sha);
  assert.equal((await switchTo(h.place, join(h.releases, name), 'diagnostic')).release, name);
  assert.equal(readlinkSync(join(h.releases, 'previous')), sha);
  assert.equal((await switchTo(h.place, linkTarget(h.releases, 'previous')!)).release, sha);
  assert.equal(readlinkSync(join(h.releases, 'previous')), name);
  assert.deepEqual(prune(h.releases, 0, () => {}), ['unused']);
});

test('kind/content/name/root mismatch is rejected before drain, stop or journal changes, including resume/current', async t => {
  const sha = 'b'.repeat(40), name = sha + '-diagnostic';
  const h = setup(t, { [sha]: 'f1', [name]: 'f1' });
  const diagnostic = join(h.releases, name), production = join(h.releases, sha);
  diagnosticArtifacts(diagnostic, sha); await h.start(sha);
  await assert.rejects(switchTo(h.place, production, 'diagnostic'), /kind\/content mismatch/);
  await assert.rejects(switchTo(h.place, diagnostic, 'production'), /kind\/content mismatch/);
  assert.deepEqual(h.log, []); assert.equal(existsSync(join(h.releases, 'switch.json')), false);
  writeFileSync(join(diagnostic, 'SOURCE'), 'c'.repeat(40));
  await assert.rejects(switchTo(h.place, diagnostic), /mismatch/);
  writeFileSync(join(diagnostic, 'SOURCE'), sha);
  const stop = platform.service.stop; platform.service.stop = () => false;
  await assert.rejects(switchTo(h.place, diagnostic), /did not stop/);
  const before = readFileSync(join(h.releases, 'switch.json'), 'utf8'); h.log.length = 0;
  writeFileSync(join(diagnostic, 'apps/backend/public/index.html'), '<script src="/assets/wrong.js"></script>');
  await assert.rejects(switchTo(h.place, diagnostic), /disconnected/);
  assert.equal(readFileSync(join(h.releases, 'switch.json'), 'utf8'), before); assert.deepEqual(h.log, []);
  platform.service.stop = stop;
  await assert.rejects(switchTo({ ...h.place, releases: join(h.releases, 'other') }, production), /outside its root/);
});

test('removing actual edition preflight makes the requested-kind regression fail', async t => {
  const h = setup(t, { a: 'same' }); await h.start('a');
  const source = new URL('../apps/backend/test-dist/release/switch.js', import.meta.url), code = readFileSync(source, 'utf8');
  const changed = code.replace('validateRelease(releases, target, requested);', 'void 0;');
  assert.notEqual(changed, code);
  const resolvable = changed.replace(/from (['"])([^'"]+)\1/g, (match, quote: string, specifier: string) =>
    specifier.startsWith('node:') ? match : `from ${quote}${specifier.startsWith('.') ? new URL(specifier, source).href : import.meta.resolve(specifier)}${quote}`);
  const file = join(h.workspace, 'switch-without-edition-validation.mjs'); writeFileSync(file, resolvable);
  const subject = await import(pathToFileURL(file).href);
  await assert.rejects(async () => assert.rejects(subject.switchTo(h.place, join(h.releases, 'a'), 'diagnostic'), /kind\/content mismatch/),
    { code: 'ERR_ASSERTION', message: /Missing expected rejection/ });
});

test('missing live history refuses before drain without inventing an empty prefix', async t => {
  const h = setup(t, {a:'f1', b:'f1'}); await h.start('a');
  h.state.contractUsers.push({runId:'R1',attemptId:'a1',format:'f1'});
  h.state.legacyHttp = true; h.save();
  await assert.rejects(switchTo(h.place, join(h.releases, 'b')), /Database history is missing/);
  assert.deepEqual(h.log, []); assert.equal(h.current(), 'a');
});

test('same16 readiness with a different history is refused and an unchanged old schema is restored', async t => {
  const h=setup(t,{a:'f1',b:'f1'});await h.start('a');h.state.wrongReadyHistory=true;h.save();
  await assert.rejects(switchTo(h.place,join(h.releases,'b')),/did not become ready.*old serve restored/);
  assert.equal(h.current(),'a');assert.equal(h.journal().phase,'aborted');
});

test('dependency-log migration history rejects the previous same-FORMAT reader before drain or stop', async t => {
  const h = setup(t, { old: 'same-format', candidate: 'same-format' });
  const history = controlSchemaManifest().history;
  const dependencyIndex = history.findIndex(entry => /dependency_history$/.test(entry.name));
  assert.notEqual(dependencyIndex, -1, 'dependency_history migration must exist');
  writeFileSync(join(h.releases, 'old', 'SCHEMA.json'), JSON.stringify({ control: { version: CURRENT, history: history.slice(0, dependencyIndex) }, host: [] }));
  await h.start('candidate');
  point(h.releases, 'previous', join(h.releases, 'old'));
  const connection = readFileSync(join(h.workspace, '.alpacawork/connection.json'));
  const data = readFileSync(join(h.workspace, 'inspection.json'));
  await assert.rejects(switchTo(h.place, { link: 'previous' }), /Target cannot open this database schema\/history/);
  assert.deepEqual(h.log, [], 'no drain, service stop, restart, or maintenance');
  assert.equal(h.current(), 'candidate');
  assert.deepEqual(readFileSync(join(h.workspace, '.alpacawork/connection.json')), connection);
  assert.deepEqual(readFileSync(join(h.workspace, 'inspection.json')), data);
});
