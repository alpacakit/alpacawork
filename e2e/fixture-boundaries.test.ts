import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFixtureCleanup } from './fixture-cleanup.ts';
import { applyPageClock } from './page-clock.ts';
import { SAMPLE_NOW } from './fixture/sample.ts';
test('cleanup retains primary, stop and save faults and attempts all stages', async () => {
  const primary = Error('original'), stop = Error('stop'), save = Error('save'), seen: unknown[] = [];
  await assert.rejects(withFixtureCleanup(async () => { throw primary; }, [
    { name: 'stop', run: async () => { throw stop; } }, { name: 'save', run: async () => { throw save; } },
  ], errors => { seen.push(errors.map(each => each.stage)); }), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [primary, stop, save]);
    assert.equal(error.message, 'use: original\nstop: stop\nsave: save'); assert.equal(error.cause, primary); return true;
  });
  assert.deepEqual(seen.at(-1), ['use', 'stop', 'save']);
});
test('cleanup rethrows a sole use, teardown or record error with original identity and diagnosis', async () => {
  for (const failing of ['use', 'stop', 'record']) {
    const original = Error(`original ${failing} diagnostic`), stages: string[] = [];
    await assert.rejects(withFixtureCleanup(async () => { if (failing === 'use') throw original; }, [
      { name: 'stop', run: async () => { stages.push('stop'); if (failing === 'stop') throw original; } },
      { name: 'save', run: async () => { stages.push('save'); } },
    ], () => { if (failing === 'record' && stages.length === 0) throw original; }), error => {
      assert.equal(error, original); assert.equal(error.message, `original ${failing} diagnostic`); assert.equal(error.stack, original.stack); return true;
    });
    assert.deepEqual(stages, ['stop', 'save']);
  }
});
test('cleanup keeps record faults alongside the original error and preserves normal operation', async () => {
  const primary = Error('expect detail'), record = Error('JSON write detail');
  await assert.rejects(withFixtureCleanup(async () => { throw primary; }, [], () => { throw record; }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.cause, primary); assert.deepEqual(error.errors, [primary, record]);
    assert.equal(error.message, 'use: expect detail\nrecord: JSON write detail'); return true;
  });
  const seen: string[] = [];
  await withFixtureCleanup(async () => { seen.push('use'); }, [{ name: 'stop', run: async () => { seen.push('stop'); } }], () => { seen.push('record'); });
  assert.deepEqual(seen, ['use', 'record', 'stop', 'record']);
});
test('standard and persistent callers share Date-only clock preparation', async () => {
  const dates: unknown[] = [];
  const page = { clock: { setFixedTime: async (date: Date | number) => { dates.push(date); } } };
  await applyPageClock(page, true); await applyPageClock(page, false);
  assert.deepEqual(dates, [new Date(SAMPLE_NOW)]);
});
