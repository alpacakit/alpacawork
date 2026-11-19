/** Release migration and forward recovery; cases remain serial within this process. */
/** Switch protocol through its real journal/files, with a local service adapter; systemd is exercised separately. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { failure, platform } from "@alpacawork/core";
import { controlSchemaManifest } from "@alpacawork/db";
import { point } from "@alpacawork/backend/test-dist/release/layout.js";
import { prune, switchTo } from "@alpacawork/backend/test-dist/release/switch.js";
import { CURRENT, NEXT, futureSchema, setup, migrationSetup } from './helpers/release-switch-fixture.ts';

test('deploy takes an automatic migration from the release manifest before selecting or starting the target', async t => {
  assert.equal(futureSchema.version, CURRENT);
  assert.equal(futureSchema.history.length, controlSchemaManifest().history.length + 1);
  const h = migrationSetup(t); await h.start('a');
  const ready = await switchTo(h.place, h.target);
  assert.equal(ready.release, 'b');
  assert.deepEqual(h.migrations().map(event => ({ stopped: event.stopped, current: event.current, schema: event.schemaBefore })),
    [{ stopped: true, current: 'a', schema: CURRENT }]);
  assert.equal(h.state.schema, NEXT);
  assert.deepEqual(h.log.filter(line => ['drain', 'stop', 'restart'].includes(line)), ['drain', 'stop', 'restart']);
  assert.equal(h.journal().phase, 'committed');
});

test('a failed pre-COMMIT migration durably aborts after restoring the old serve; retry drains a fresh generation', async t => {
  const h = migrationSetup(t); await h.start('a');
  const restart = platform.service.restart;
  platform.service.restart = service => {
    assert.equal(h.journal().phase, 'restoring_old', 'restart intent must already be durable');
    assert.equal(h.current(), 'a');
    return restart(service);
  };
  writeFileSync(join(h.target, 'fail-before-migrate'), '');
  await assert.rejects(switchTo(h.place, h.target), /Switch aborted.*old serve restored/);
  const aborted = h.journal();
  assert.equal(aborted.phase, 'aborted'); assert.equal(h.current(), 'a');
  assert.match(aborted.abortReason, /Stopped-server migration failed/);
  assert.equal(JSON.parse(readFileSync(join(h.workspace, 'inspection.json'), 'utf8')).schema, CURRENT);
  assert.equal(existsSync(join(h.workspace, 'service-stopped')), false);
  assert.deepEqual(h.log.filter(line => ['drain', 'stop', 'restart'].includes(line)), ['drain', 'stop', 'restart']);
  platform.service.restart = restart;
  rmSync(join(h.target, 'fail-before-migrate')); h.log.length = 0;
  assert.equal((await switchTo(h.place, h.target)).release, 'b');
  assert.notEqual(h.journal().opId, aborted.opId);
  assert.notEqual(h.journal().drained.generation, aborted.drained.generation);
  assert.deepEqual(h.log.filter(line => ['drain', 'stop', 'restart'].includes(line)), ['drain', 'stop', 'restart']);
  assert.deepEqual(h.migrations().map(event => ({ stopped: event.stopped, schema: event.schemaBefore })),
    [{ stopped: true, schema: CURRENT }, { stopped: true, schema: CURRENT }]);
});

test('an interrupted old-serve restart resumes restoration without assuming the service is stopped', async t => {
  const h = migrationSetup(t); await h.start('a');
  writeFileSync(join(h.target, 'fail-before-migrate'), '');
  const restart = platform.service.restart;
  platform.service.restart = service => { restart(service); throw new Error('Interrupted after old restart'); };
  await assert.rejects(switchTo(h.place, h.target), /Interrupted after old restart/);
  const pending = h.journal(); assert.equal(pending.phase, 'restoring_old');
  await delay(30); assert.equal(existsSync(join(h.workspace, 'service-stopped')), false);
  platform.service.restart = restart; h.log.length = 0;
  await assert.rejects(switchTo(h.place, h.target), /Switch aborted.*old serve restored/);
  assert.equal(h.journal().phase, 'aborted'); assert.equal(h.journal().opId, pending.opId);
  assert.deepEqual(h.log.filter(line => ['drain', 'stop', 'restart'].includes(line)), ['drain', 'stop', 'restart']);
  assert.notEqual(h.journal().drained.generation, pending.drained.generation);
  assert.equal(h.migrations().length, 1);
});

test('failed recovery inspection leaves the old release stopped and resumes forward', async t => {
  const h = migrationSetup(t); await h.start('a');
  writeFileSync(join(h.target, 'fail-before-migrate'), '');
  writeFileSync(join(h.target, 'fail-inspect-after-migrate'), '');
  await assert.rejects(switchTo(h.place, h.target), /inspection failed/);
  const pending = h.journal();
  assert.equal(pending.phase, 'old_stopped'); assert.equal(h.current(), 'a');
  assert.equal(h.log.includes('restart'), false);
  assert.equal(existsSync(join(h.workspace, 'service-stopped')), true);
  assert.equal(JSON.parse(readFileSync(join(h.workspace, 'inspection.json'), 'utf8')).schema, CURRENT);
  rmSync(join(h.target, 'fail-before-migrate')); rmSync(join(h.target, 'fail-inspect'));
  rmSync(join(h.target, 'fail-inspect-after-migrate'));
  assert.equal((await switchTo(h.place, h.target)).release, 'b');
  assert.equal(h.journal().opId, pending.opId);
  assert.equal(h.migrations().length, 2);
});

test('failed initial target inspection never starts the old release', async t => {
  const h = migrationSetup(t); await h.start('a'); writeFileSync(join(h.target, 'fail-inspect'), '');
  await assert.rejects(switchTo(h.place, h.target), /inspection failed/);
  assert.equal(h.journal().phase, 'old_stopped'); assert.equal(h.current(), 'a');
  assert.equal(h.log.includes('restart'), false); assert.equal(h.migrations().length, 0);
});

test('recovery refuses a changed current or an old release that cannot open the inspected schema', async t => {
  for (const failure of ['current', 'schema'] as const) await t.test(failure, async t => {
    const h = migrationSetup(t); await h.start('a'); writeFileSync(join(h.target, 'fail-before-migrate'), '');
    const stop = platform.service.stop;
    platform.service.stop = service => {
      const stopped = stop(service);
      if (failure === 'current') point(h.releases, 'current', join(h.releases, 'c'));
      else writeFileSync(join(h.releases, 'a', 'SCHEMA.json'), JSON.stringify({ control: { version: 3 }, host: [] }));
      return stopped;
    };
    await assert.rejects(switchTo(h.place, h.target), failure === 'current' ? /links disagree/ : /Stopped-server migration failed/);
    if (failure === 'current') { assert.equal(h.current(), 'c'); assert.equal(h.migrations().length, 0); }
    assert.equal(h.journal().phase, 'old_stopped'); assert.equal(h.log.includes('restart'), false);
  });
});

test('database commit followed by a target crash resumes maintenance and never starts the old release', async t => {
  const h = migrationSetup(t); await h.start('a');
  writeFileSync(join(h.target, 'fail-after-migrate-commit'), '');
  await assert.rejects(switchTo(h.place, h.target), /Stopped-server migration failed/);
  const pending = h.journal();
  assert.equal(pending.phase, 'old_stopped'); assert.equal(h.current(), 'a');
  assert.equal(JSON.parse(readFileSync(join(h.workspace, 'inspection.json'), 'utf8')).schema, NEXT);
  assert.equal(h.log.includes('restart'), false);
  const calls = h.migrations().length;
  await assert.rejects(switchTo(h.place, join(h.releases, 'c')), /pending switch/);
  assert.equal(h.migrations().length, calls);
  prune(h.releases, 0, () => {});
  assert.ok(existsSync(h.target), 'forward recovery retains the target even before current selects it');
  rmSync(join(h.target, 'fail-after-migrate-commit'));
  assert.equal((await switchTo(h.place, h.target)).release, 'b');
  assert.equal(h.journal().opId, pending.opId);
  assert.deepEqual(h.migrations().map(event => event.schemaBefore), [CURRENT, NEXT]);
  assert.equal(h.journal().phase, 'committed');
});

test('removing the maintenance call from the release subject makes the migration regression fail', async t => {
  const h = migrationSetup(t); await h.start('a');
  const source = new URL('../apps/backend/test-dist/release/switch.js', import.meta.url);
  const code = readFileSync(source, 'utf8');
  const removed = code.replace('await migrate(place, target);', 'undefined;');
  assert.notEqual(removed, code, 'the deliberate substitution must remove the actual subject call');
  const resolvable = removed.replace(/from (['"])([^'"]+)\1/g, (match, quote: string, specifier: string) =>
    specifier.startsWith('node:') ? match : `from ${quote}${specifier.startsWith('.') ? new URL(specifier, source).href : import.meta.resolve(specifier)}${quote}`);
  const file = join(h.workspace, 'switch-without-maintenance.mjs'); writeFileSync(file, resolvable);
  const subject = await import(pathToFileURL(file).href);
  await assert.rejects(subject.switchTo(h.place, h.target), /migration did not reach the target schema/);
  assert.equal(h.current(), 'a'); assert.equal(h.migrations().length, 0);
});

test('same16 modified or reordered target histories refuse before drain and preserve the old serve', async t => {
  for (const fault of ['modified', 'reordered'] as const) await t.test(fault, async t => {
    const h = setup(t, { a: 'f1', b: 'f1' }); await h.start('a');
    const control = fault === 'modified' ? { ...controlSchemaManifest(), history: controlSchemaManifest().history.map(row => ({ ...row, hash: 'c'.repeat(64) })) }
      : { ...futureSchema, history: [...futureSchema.history].reverse() };
    writeFileSync(join(h.releases, 'b', 'SCHEMA.json'), JSON.stringify({ control, host: [] }));
    await assert.rejects(switchTo(h.place, join(h.releases, 'b')), /history/);
    assert.deepEqual(h.log, []); assert.equal(h.current(), 'a');
  });
});

test('readiness failure cannot restore a release declaring another database version', async t => {
  const h = setup(t, { a: 'f1', b: 'f1' });
  await h.start('a');
  const file = join(h.releases, 'a', 'SCHEMA.json'), old = JSON.parse(readFileSync(file, 'utf8'));
  old.control.history = futureSchema.history;
  writeFileSync(file, JSON.stringify(old));
  writeFileSync(join(h.releases, 'b', 'broken'), '');
  await assert.rejects(switchTo(h.place, join(h.releases, 'b')), /forward recovery/);
  assert.equal(h.current(), 'b');
  assert.equal(h.state.schema, CURRENT);
  assert.equal(h.journal().phase, 'target_selected');
  assert.equal(existsSync(join(h.workspace, 'service-stopped')), true);
});

test('readiness recovery rechecks the old execution contract and stop publication before selecting it', async t => {
  for (const blocker of ['format', 'unpublished-stop'] as const) await t.test(blocker, async t => {
    const h = setup(t, { a: 'f1', b: 'f2' });
    await h.start('a');
    writeFileSync(join(h.releases, 'b', 'broken'), '');
    const restart = platform.service.restart;
    platform.service.restart = service => {
      if (h.current() === 'b') {
        if (blocker === 'format') h.state.contractUsers.push({ runId: 'R2', attemptId: 'new-contract', format: 'f2' });
        else h.state.unpublishedStops = 1;
        h.save();
      }
      return restart(service);
    };
    await assert.rejects(switchTo(h.place, join(h.releases, 'b')), blocker === 'format' ? /FORMAT differs/ : /not all been published/);
    assert.equal(h.current(), 'b');
    assert.equal(h.journal().phase, 'target_selected');
    assert.equal(existsSync(join(h.workspace, 'service-stopped')), true);
    assert.equal(h.log.filter(line => line === 'restart').length, 1, 'only the failed target was started');
  });
});

test('a refused old restart after failed readiness resumes the same restoring journal', async t => {
  const h = setup(t, { a: 'f1', b: 'f1' });
  await h.start('a');
  writeFileSync(join(h.releases, 'b', 'broken'), '');
  const restart = platform.service.restart;
  platform.service.restart = service => {
    if (h.current() !== 'a') return restart(service);
    assert.equal(h.journal().phase, 'restoring_old', 'intent is durable before restart');
    return false;
  };
  await assert.rejects(switchTo(h.place, join(h.releases, 'b')), /earlier serve both failed/);
  const pending = h.journal();
  assert.equal(pending.phase, 'restoring_old');
  assert.equal(h.current(), 'a');
  platform.service.restart = restart;
  await assert.rejects(switchTo(h.place, join(h.releases, 'b')), /old serve restored/);
  assert.equal(h.journal().phase, 'aborted');
  assert.equal(h.journal().opId, pending.opId);
  assert.equal(existsSync(join(h.workspace, 'service-stopped')), false);
});
