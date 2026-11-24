import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { routingDriver } from './helpers/projection/routing-driver.ts';
import { coreDriver } from './helpers/projection/core-driver.ts';
import { auditReplay, coverageSteps, operationKinds, operations, assertEquivalent, assertDependencies, meaning } from './helpers/projection/harness.ts';

test('seeded small-fixture writes keep records, read resources, routing and freshness proofs equivalent', async t => {
  const fixture = await coreDriver(); t.after(() => fixture.close());
  const routing = await routingDriver(); t.after(() => routing.close());
  const steps = coverageSteps;
  const result = await auditReplay({ ...fixture.driver, routing: routing.adapter }, 901, steps);
  if (process.env.PROJECTION_REPLAY_REPORT) writeFileSync(process.env.PROJECTION_REPLAY_REPORT, JSON.stringify(result, null, 2) + '\n');
  t.diagnostic(JSON.stringify({ ...result, issues: result.issues.length }));
  assert.ok(result.dependencyChecks > 0, 'the actual recorded reads activated dependency checks');
  assert.deepEqual([...fixture.executed].sort(), [...operationKinds].sort());
  assert.equal(result.written, steps);
  assert.equal(result.routingSteps, steps);
  assert.equal(result.publicationSteps, steps);
  assert.deepEqual(result.pending, []);
  assert.ok(result.routingCoverage.automaticRequests! > 0, 'the routing comparison includes automatic continuations');
  assert.equal(result.issues.length, 0, JSON.stringify(result.issues.slice(0, 6), null, 2));
});

test('the same seed reproduces the entire operation trace and all operation families occur', () => {
  assert.deepEqual(operations(91), operations(91));
  assert.notDeepEqual(operations(91), operations(92));
  assert.deepEqual([...new Set(operations(91).map(op => op.kind))].sort(), [...operationKinds].sort());
});

test('equivalence checks reject a semantic difference and a changed resource with an unchanged proof', () => {
  const previous = { pv: 1, value: { value: 1 }, resources: [{ kind: 'view' as const, id: 'T1', value: { title: 'a' }, requiredPv: 1 }] };
  const full = { pv: 2, value: { value: 2 }, resources: [{ kind: 'view' as const, id: 'T1', value: { title: 'b' }, requiredPv: 2 }] };
  assert.throws(() => assertEquivalent(previous, full), /meaning differs/);
  assert.throws(() => assertEquivalent({ ...full, resources: [{ ...full.resources[0]!, requiredPv: 1 }] }, full, previous), /requiredPv/);
  assert.deepEqual(meaning({ generation: 'g', sourcePv: 2, task: { version: 3, revision: 4 } }), { task: { revision: 4, version: 3 } });
  assert.deepEqual(meaning({ pv: 3, view: { sourcePv: 2, generation: 'g', task: { values: { pv: 9, sourcePv: 8, generation: 'business text' } } } }),
    { view: { task: { values: { generation: 'business text', pv: 9, sourcePv: 8 } } } }, 'transport names inside user values are still business data');
  const cursor = (version: string, id = 'T2') => Buffer.from(JSON.stringify({ generation: 'g', version, id })).toString('base64url');
  assert.deepEqual(meaning({ nextAfter: cursor('1') }), meaning({ nextAfter: cursor('2') }));
  assert.notDeepEqual(meaning({ nextAfter: cursor('1') }), meaning({ nextAfter: cursor('1', 'T3') }));

});

test('an omitted surface is rejected using the read recorder evidence', async t => {
  const fixture = await coreDriver(); t.after(() => fixture.close());
  const probes = await fixture.driver.write({ kind: 'title', target: 2, variant: 1, step: 1 });
  const active = probes.find(probe => JSON.stringify(probe.before) !== JSON.stringify(probe.after) && probe.target === 'T2')!;
  assert.doesNotThrow(() => assertDependencies([{ ...active, withOldOwner: () => active.after, affectedByOwner: undefined, affected: { tasks: new Map(), scopes: { page: new Set(), timeline: new Set(), search: new Set() }, meta: false } }]), 'an unused field in a broadly read supplier does not create a dependency');
  assert.throws(() => assertDependencies([{ ...active, affectedByOwner: undefined, affected: { tasks: new Map(), scopes: { page: new Set(), timeline: new Set(), search: new Set() }, meta: false } }]), /omitted that surface/);
});
