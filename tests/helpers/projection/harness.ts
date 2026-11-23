/** One replay loop for projection equivalence. Missing adapters are reported, never counted as verified behavior. */
import assert from 'node:assert/strict';
import type { AffectedSet, Facet, RecordsReader, ScreenAggregate, PublishedFrame } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';
import { recordReads, type RecordedRead } from '@alpacawork/backend/test-dist/receiver/screen-derive.js';

export const operationKinds = ['create', 'title', 'values', 'state', 'question', 'answer', 'request', 'placement', 'dependency', 'move', 'lifecycle',
  'run-state', 'run-usage-session', 'joined-resumes', 'delivery', 'input-uncertain', 'files', 'config', 'person', 'read-failure', 'error-cause', 'schema', 'return', 'joined-delivery', 'delivery-uncertain', 'coordinator-join', 'coordinator-complete', 'wait-cycle'] as const;
export type OperationKind = typeof operationKinds[number];
/** `task`: the Task an operation names when it is not `T<target>` (the nested project, mutations.nestProject). */
export interface Operation { readonly kind: OperationKind; readonly step: number; readonly target: number; readonly variant: number; readonly task?: string }
const scenarios: Omit<Operation, 'step'>[] = [
  ...[0, 1, 2, 3].map(variant => ({ kind: 'run-state' as const, variant, target: 2 })),
  ...[0, 1].map(variant => ({ kind: 'joined-resumes' as const, variant, target: 2 })),
  { kind: 'joined-delivery' as const, variant: 1, target: 2 },
  { kind: 'delivery-uncertain' as const, variant: 1, target: 2 },
  ...[0, 1].map(variant => ({ kind: 'error-cause' as const, variant, target: 2 })),
  // Shelving the nested project and taking it back: what the rows above read of its Tasks comes and goes.
  ...[0, 1].map(variant => ({ kind: 'lifecycle' as const, variant, target: 15, task: 'P15' })),
];
/** The replay length that runs every operation family once and then every scenario. */
export const coverageSteps = operationKinds.length + scenarios.length;
/** A coverage prefix followed by a seeded random sequence: rare families occur even in short replays. */
export function operations(seed: number, steps = 200): Operation[] {
  let state = seed >>> 0 || 1;
  const random = (max: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % max; };
  return Array.from({ length: steps }, (_, step) => {
    const target = 2 + random(13), variant = random(1000);
    return step < operationKinds.length ? { kind: operationKinds[step]!, step, target, variant }
      : step < operationKinds.length + scenarios.length ? { ...scenarios[step - operationKinds.length]!, step }
      : { kind: operationKinds[random(operationKinds.length)]!, step, target, variant };
  });
}
const transport = new Set(['pv', 'sourcePv', 'requiredPv', 'generation', 'applied']);
/** Normalize transport proofs, Maps, Sets, bigint and object key order, retaining business revisions and array order. */
export function meaning(value: unknown, depth = 0, businessData = false): unknown {
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Map) return Object.fromEntries([...value].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([key, entry]) => [String(key), meaning(entry, depth + 1, businessData)]));
  if (value instanceof Set) return [...value].map(item => meaning(item, depth + 1, businessData)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : meaning(item, depth + 1, businessData));
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const proof = !businessData && (depth === 0 || typeof object.sourcePv === 'number' || typeof object.pv === 'number' && typeof object.generation === 'string');
    return Object.fromEntries(Object.entries(object).filter(([key, entry]) => entry !== undefined &&
      !(proof && transport.has(key)) && !(proof && depth === 0 && key === 'rev')).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) =>
        [key, !businessData && key === 'nextAfter' && typeof entry === 'string' ? cursorMeaning(entry) : meaning(entry, depth + 1, businessData || ['values', 'settings', 'launchValues', 'decide'].includes(key))]));
  }
  return value;
}
/** Pagination tokens contain transport versions; keep their actual position and scope in the semantic comparison. */
function cursorMeaning(token: string): unknown {
  try {
    const { generation: _generation, version: _version, ...position } = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    return meaning(position);
  } catch { return token; }
}
const equal = (a: unknown, b: unknown) => JSON.stringify(meaning(a)) === JSON.stringify(meaning(b));
export type ResourceKind = 'view' | 'history' | 'page' | 'search' | 'timeline' | 'axis';
export interface Resource { readonly kind: ResourceKind; readonly id: string; readonly value: unknown; readonly requiredPv: number }
export interface Observation { readonly pv: number; readonly value: unknown; readonly resources: readonly Resource[] }
export interface DependencyProbe {
  readonly target: string; readonly facet: Facet; readonly before: unknown; readonly after: unknown;
  readonly scope?: { readonly kind: 'page' | 'search' | 'timeline'; readonly id: string };
  readonly reads: readonly RecordedRead[]; readonly affected: AffectedSet; readonly changedOwners: ReadonlySet<string>;
  readonly beforeRecords: RecordsReader; readonly afterRecords: RecordsReader;
  readonly affectedByOwner?: ReadonlyMap<string, AffectedSet>;
  readonly withOldOwner?: (owner: string) => unknown;
}
/** Broad bundle reads alone do not imply a dependency on every field. A probe is activated when its semantic output
 * changes, then every changed supplier actually read must reach the target's surface. The replay provides isolated
 * mutations as well as batches; a missing invalidation cannot be masked by rederiving every Task. */
export function assertDependencies(probes: readonly DependencyProbe[]): number {
  let checked = 0;
  for (const probe of probes) {
    if (equal(probe.before, probe.after) || probe.scope && probe.before === undefined) continue;
    const owners = new Set(probe.reads.flatMap(read => readOwners(read, probe.beforeRecords, probe.afterRecords)));
    for (const owner of probe.changedOwners) if (owners.has(owner)) {
      if (probe.withOldOwner) {
        let unchanged = false;
        try { unchanged = equal(probe.after, probe.withOldOwner(owner)); }
        catch { /* A newly required supplier may not exist at the preceding point. */ }
        if (unchanged) continue;
      }
      checked++;
      const impact = probe.affectedByOwner?.get(owner) ?? probe.affected;
      assert.ok(probe.scope ? impact.scopes[probe.scope.kind].has(probe.scope.id) : impact.tasks.get(probe.target)?.has(probe.facet),
        `${probe.target}.${probe.facet} changed after reading ${owner}, but affected omitted that surface; reads=${JSON.stringify([...new Set(probe.reads.filter(read => readOwners(read, probe.beforeRecords, probe.afterRecords).includes(owner)).map(read => `${read.from}.${read.method}(${String(read.args[0])})`))].slice(0, 8))}`);
    }
  }
  return checked;
}
/** Resolve keys read through a reverse index back to the same Task owners used by the dependency ledger. */
function readOwners(read: RecordedRead, ...records: RecordsReader[]): string[] {
  const key = read.args[0]; if (typeof key !== 'string') return [];
  if (read.from === 'aggregate' || read.from === 'derived') return [key];
  const byMethod: Record<string, (r: RecordsReader) => string | null | undefined> = {
    run: r => r.runOwner(key), runOwner: r => r.runOwner(key), runReferrers: r => r.runOwner(key),
    logOwner: r => r.logOwner(key), placementOwner: r => r.placementOwner(key), placementWritesTo: r => r.placementOwner(key),
    requestOwner: r => r.requestOwner(key), closedRequest: r => r.requestOwner(key), runByRequest: r => r.requestOwner(key),
    deliveriesByWakeRequest: r => r.requestOwner(key), returnOwner: r => r.returnOwner(key),
  };
  const lookup = byMethod[read.method];
  return [...new Set(records.flatMap(r => { const owner = lookup ? lookup(r) : r.bundle(key) ? key : undefined; return owner ? [owner] : []; }))];
}
/** Substitute only the named supplier's old reads. Broad bundle reads whose changed fields were unused then
 * leave the result unchanged; an atomic multi-owner write cannot falsely blame all suppliers read by that result. */
export function oldOwnerRecords(before: RecordsReader, after: RecordsReader, owner: string): RecordsReader {
  return new Proxy(after, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      const old = readOwners({ from: 'records', method: String(key), args }, before, after).includes(owner);
      return Reflect.get(old ? before : after, key).apply(old ? before : after, args);
    };
  } });
}
export function oldOwnerFrame(before: PublishedFrame, after: PublishedFrame, owner: string): PublishedFrame {
  return { ...after, records: oldOwnerRecords(before.records, after.records, owner),
    derived: id => id === owner ? before.derived(id) : after.derived(id),
    aggregate: new Proxy(after.aggregate, { get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { const source = args[0] === owner ? before.aggregate : after.aggregate;
        return Reflect.get(source, key).apply(source, args); };
    } }) };
}
export function trace<T>(records: RecordsReader, aggregate: ScreenAggregate | undefined,
  read: (records: RecordsReader, aggregate?: ScreenAggregate) => T): { value: T; reads: RecordedRead[] } {
  const reads: RecordedRead[] = [];
  return { value: read(recordReads(records, reads, 'records'), aggregate && recordReads(aggregate, reads, 'aggregate')), reads };
}
export function assertEquivalent(incremental: Observation, full: Observation, previousFull?: Observation): void {
  assert.deepEqual(meaning(incremental.value), meaning(full.value), 'incremental meaning differs from a fresh full projection');
  const key = (r: Resource) => `${r.kind}:${r.id}`;
  const actual = new Map(incremental.resources.map(r => [key(r), r]));
  const previous = new Map(previousFull?.resources.map(r => [key(r), r]));
  assert.deepEqual([...actual.keys()].sort(), full.resources.map(key).sort(), 'resource membership differs');
  for (const resource of full.resources) {
    const got = actual.get(key(resource)); assert.ok(got, `missing resource ${key(resource)}`);
    assert.deepEqual(meaning(got.value), meaning(resource.value), `${key(resource)} meaning differs`);
    if (previousFull && previous.has(key(resource)) && !equal(previous.get(key(resource))?.value, resource.value)) raised(got, incremental.pv);
  }
}
/** A resource served differently from before is required from this publication on. */
function raised(resource: Resource, pv: number) {
  assert.ok(resource.requiredPv >= pv, `${resource.kind}:${resource.id} changed without raising requiredPv to ${pv} (got ${resource.requiredPv})`);
  assert.ok(resource.requiredPv <= pv, `${resource.kind}:${resource.id} claims a future projection`);
}
/** What a publication serves against what was served before it, when no full projection can say the same (a failed derivation keeps its Task's last facts). */
export function assertRaised(current: Observation, previous: Observation): void {
  const before = new Map(previous.resources.map(r => [`${r.kind}:${r.id}`, r]));
  for (const resource of current.resources) {
    const held = before.get(`${resource.kind}:${resource.id}`);
    if (held && !equal(held.value, resource.value)) raised(resource, current.pv);
  }
}
export interface HarnessDriver {
  readonly capabilities: readonly string[];
  observe(): Promise<{ incremental: Observation; full: Observation }>;
  write(operation: Operation): Promise<readonly DependencyProbe[]>;
  /** Real catch-up publications are compared independently, with their own versions and arrival floors. */
  publication?: { verify(): Promise<{ incremental: Observation; full: Observation; applied: number; floor: number }> };
  /** Routing adapters run a full residual pass and compare business effects with a separate full-routing workspace. */
  routing?: { verify(operation: Operation): Promise<{ residualWrites: number; targeted: unknown; full: unknown; dependencyProbes?: readonly DependencyProbe[]; coverage?: Readonly<Record<string, number>> }> };
  /** The adapter corrupts only derived values, runs the bounded audit/repair, and returns observations from that point. */
  repair?: { verify(): Promise<{ repaired: Observation; full: Observation }> };
  /** The server publication owner's audit repairs a corrupted frame: what it publishes, and what was served before. */
  ownerRepair?: { verify(): Promise<{ repaired: Observation; full: Observation; previous: Observation }> };
  /** A derivation fails for a written Task and is retried: what was served before the write, while the derivation
   * failed, and what the retry publishes. */
  retry?: { verify(): Promise<{ before: Observation; failed: Observation; retried: Observation; full: Observation }> };
  /** Lag the projection beyond a small ChangeLog cap, recover through its real catch-up, then read at the current floor. */
  resync?: { verify(): Promise<{ recovered: Observation; full: Observation; applied: number; floor: number }> };
}
export interface ReplayResult { readonly seed: number; readonly steps: number; readonly dependencyChecks: number; readonly verified: readonly string[]; readonly pending: readonly string[] }
/** Strict consumer of the same audit loop; no second operation or comparison path. */
export async function replay(driver: HarnessDriver, seed: number, steps = 200): Promise<ReplayResult> {
  const result = await auditReplay(driver, seed, steps);
  const first = result.issues[0];
  if (first) throw new Error(`Projection replay failed: seed=${seed}, step=${first.step}, operation=${JSON.stringify(first.operation)}: ${first.check}`, { cause: new Error(first.message) });
  return { seed, steps: result.written, dependencyChecks: result.dependencyChecks, verified: result.enabled, pending: result.pending };
}

export interface ReplayIssue { step: number; operation: Operation | null; check: string; message: string; difference?: unknown }
/** Continue independent comparisons after a product discrepancy, so one missing surface does not hide other families.
 * No product state is repaired or reset on a discrepancy. A failed write stops the trace, since later keys would no
 * longer describe its publication. The strict replay wrapper uses this same loop and rejects any collected discrepancy. */
export async function auditReplay(driver: HarnessDriver, seed: number, steps = 200) {
  const issues: ReplayIssue[] = [];
  const routingCoverage: Record<string, number> = {};
  let routingSteps = 0, routingFailed = false, publicationSteps = 0, previousPublication: Observation | undefined;
  let checks = 0, written = 0, previous: Observation | undefined;
  const check = (name: string, op: Operation | null, fn: () => void, difference?: unknown) => {
    try { fn(); } catch (error) { issues.push({ step: op?.step ?? -1, operation: op, check: name,
      message: error instanceof Error ? error.message.split('\n')[0]! : String(error), difference }); }
  };
  for (const op of [null, ...operations(seed, steps)]) {
    if (op) {
      let probes;
      try { probes = await driver.write(op); written++; }
      catch (error) { check('write', op, () => { throw error; }); break; }
      for (const probe of probes) check(`dependency:${probe.facet}:${probe.target}`, op,
        () => { checks += assertDependencies([probe]); });
    }
    let pair: Awaited<ReturnType<HarnessDriver['observe']>>;
    try { pair = await driver.observe(); }
    catch (error) { check('observe', op, () => { throw error; }); break; }
    const { incremental, full } = pair;
    const left = incremental.value as Record<string, unknown>, right = full.value as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) check(`result:${key}`, op,
      () => assert.deepEqual(meaning(left[key]), meaning(right[key])), firstDifference(meaning(left[key]), meaning(right[key])));
    const actual = new Map(incremental.resources.map(resource => [`${resource.kind}:${resource.id}`, resource]));
    check('resource-membership', op, () => assert.deepEqual([...actual.keys()].sort(), full.resources.map(r => `${r.kind}:${r.id}`).sort()));
    const prior = new Map(previous?.resources.map(resource => [`${resource.kind}:${resource.id}`, resource]));
    for (const resource of full.resources) {
      const name = `${resource.kind}:${resource.id}`, got = actual.get(name)!;
      check(`result:${name}`, op, () => assert.deepEqual(meaning(got?.value), meaning(resource.value)), firstDifference(meaning(got?.value), meaning(resource.value)));
      if (prior.has(name) && !equal(prior.get(name)!.value, resource.value)) check(`requiredPv:${name}`, op, () =>
        assert.equal(got.requiredPv, incremental.pv, `${name} changed at pv=${incremental.pv}; requiredPv=${got.requiredPv}`), firstDifference(meaning(prior.get(name)!.value), meaning(resource.value)));
    }
    previous = full;
    if (driver.publication) {
      try {
        const result = await driver.publication.verify();
        if (op) publicationSteps++;
        check('publication-floor', op, () => assert.ok(result.applied >= result.floor));
        check('publication', op, () => assertEquivalent(result.incremental, result.full, previousPublication),
          firstDifference(meaning(result.incremental.value), meaning(result.full.value))
            ?? firstDifference(meaning(result.incremental.resources), meaning(result.full.resources)));
        previousPublication = result.full;
      } catch (error) { check('publication', op, () => { throw error; }); }
    }
    if (op && driver.routing && !routingFailed) {
      try { const routed = await driver.routing.verify(op); routingSteps++;
        for (const [kind, value] of Object.entries(routed.coverage ?? {})) routingCoverage[kind] = Math.max(routingCoverage[kind] ?? 0, value);
        for (const probe of routed.dependencyProbes ?? []) check(`dependency:seat:${probe.target}`, op, () => { checks += assertDependencies([probe]); });
        check('routing-residual', op, () => assert.equal(routed.residualWrites, 0, `full sweep wrote ${routed.residualWrites} times`));
        check('routing-business', op, () => assert.deepEqual(meaning(routed.targeted), meaning(routed.full)), firstDifference(meaning(routed.targeted), meaning(routed.full)));
      } catch (error) { routingFailed = true; check('routing', op, () => { throw error; }); }
    }
  }
  if (driver.repair) {
    try { const result = await driver.repair.verify(); check('aggregate-repair', null, () => assertEquivalent(result.repaired, result.full)); }
    catch (error) { check('aggregate-repair', null, () => { throw error; }); }
  }
  if (driver.ownerRepair) {
    try { const result = await driver.ownerRepair.verify(); check('owner-repair', null, () => assertEquivalent(result.repaired, result.full, result.previous)); }
    catch (error) { check('owner-repair', null, () => { throw error; }); }
  }
  if (driver.retry) {
    try { const result = await driver.retry.verify();
      check('derivation-failure', null, () => assertRaised(result.failed, result.before));
      check('derivation-retry', null, () => assertEquivalent(result.retried, result.full, result.failed)); }
    catch (error) { check('derivation-retry', null, () => { throw error; }); }
  }
  if (driver.resync) {
    try { const result = await driver.resync.verify();
      check('resynchronization-floor', null, () => assert.ok(result.applied >= result.floor));
      check('resynchronization', null, () => assertEquivalent(result.recovered, result.full));
    } catch (error) { check('resynchronization', null, () => { throw error; }); }
  }
  return { seed, requested: steps, written, publicationSteps, routingSteps, routingCoverage, dependencyChecks: checks, issues, enabled: [...driver.capabilities, ...(driver.publication ? ['server-catch-up', 'atomic-publication', 'arrival-floor'] : []), ...(driver.routing ? ['routing', 'seat-reads'] : []), ...(driver.repair ? ['aggregate-repair'] : []), ...(driver.ownerRepair ? ['owner-repair'] : []), ...(driver.retry ? ['derivation-retry'] : []), ...(driver.resync ? ['resynchronization'] : [])],
    operations: Object.fromEntries(operationKinds.map(kind => [kind, operations(seed, written).filter(op => op.kind === kind).length])),
    pending: ['server-catch-up', 'bounded-audit', 'resynchronization'].filter(name => !driver.capabilities.includes(name)
      && !(name === 'server-catch-up' && driver.publication) && !(name === 'resynchronization' && driver.resync)) };
}
function firstDifference(a: unknown, b: unknown, path = '$'): unknown {
  if (JSON.stringify(a) === JSON.stringify(b)) return undefined;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const difference = firstDifference(left[key], right[key], `${path}.${key}`);
      if (difference) return difference;
    }
  }
  return { path, incremental: a, full: b };
}
