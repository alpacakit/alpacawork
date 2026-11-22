import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_SECTIONS, placeHome, type UsageTotal } from '@alpacawork/contract';
import { isFinished } from '@alpacawork/contract/branch';
import { closedPageScope } from '@alpacawork/contract/control';
import { byTaskNumber } from '@alpacawork/contract/moved';
import { aggregate, createScreenAggregate, repairScreenAggregate, updateScreenAggregate,
  type AggregateFacts, type AggregateSnapshot } from '@alpacawork/backend/test-dist/receiver/screen-aggregate.js';
import type { AggregateContribution as Contribution } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';
import { IndexPatcher, patchCandidates } from '@alpacawork/backend/test-dist/receiver/index-rows.js';
import { placeHomeRows } from '@alpacawork/contract';
import type { ProjectionVersion } from '@alpacawork/contract/control';

const zeroUsage = (): UsageTotal => ({ runs: 0, runMs: 0, tokens: null, tokensUnknown: 0 });
const task = (id: string, parentId: string | null, extra: Partial<Contribution> = {}): Contribution => ({ id, parentId, projectId: 'P1',
  kind: 'task', lifecycle: 'active', state: 'doing', baseState: 'doing', hold: false, ball: null, running: false, working: false,
  homeWorking: false, usage: zeroUsage(), openRuns: [], movedAt: 0, ...extra });
const stateCounts = () => ({ todo: 0, doing: 0, error: 0, waiting: 0, held: 0, done: 0, stopped: 0 });
const homeCounts = () => ({ doing: 0, error: 0, review: 0, awaited: 0, held: 0, todo: 0 });
const closedCounts = () => ({ finished: 0, shelved: 0 });

/** The reference deliberately walks each complete ancestor chain. It never calls the incremental implementation. */
function full(input: ReadonlyMap<string, Contribution>, facts: ReadonlyMap<string, AggregateFacts>) {
  const all = [...input.values()];
  const ancestors = (id: string, active = false): string[] => {
    const out: string[] = []; let t = input.get(id);
    while (t && (!active || t.lifecycle === 'active') && t.parentId !== null) { out.push(t.parentId); t = input.get(t.parentId); }
    return out;
  };
  const children = Object.fromEntries(all.map(t => [t.id, all.filter(c => c.parentId === t.id && c.lifecycle === 'active')]));
  const counted = Object.fromEntries(all.map(t => {
    const states = stateCounts(); let live = 0, finished = 0;
    for (const c of children[t.id]!) { states[c.state]++; if (isFinished(c.state)) finished++; else live++; }
    const below = all.filter(c => ancestors(c.id, true).includes(t.id));
    return [t.id, live + finished ? { live, finished, states, below: below.length, runningBelow: below.filter(c => c.running).length } : undefined];
  }));
  const below = (id: string) => all.filter(t => ancestors(t.id).includes(id));
  const moved = new Map(all.map(t => [t.id, Math.max(t.movedAt, ...below(t.id).map(c => c.movedAt))]));
  const placed = placeHome(all.map(t => ({ ...t, summary: { done: counted[t.id]?.states.done ?? 0,
    total: (counted[t.id]?.live ?? 0) + (counted[t.id]?.states.done ?? 0) } })),
    Object.fromEntries(all.filter(t => t.ball).map(t => [t.id, t.ball!])), new Set(all.filter(t => t.homeWorking).map(t => t.id)));
  const home = placed.flatMap(each => each.row ? [each.row] : []);
  const byMoved = (a: string, b: string) => moved.get(b)! - moved.get(a)! || byTaskNumber({ id: a }, { id: b });
  const order = home.filter(h => h.section !== 'done' && facts.get(h.taskId)?.listed !== false).sort((a, b) => HOME_SECTIONS.indexOf(a.section) - HOME_SECTIONS.indexOf(b.section) || byMoved(a.taskId, b.taskId)).map(h => h.taskId);
  const scopes = (t: Contribution) => facts.get(t.id)?.scopes ?? (() => {
    let node = input.get(t.projectId); const out: string[] = [];
    while (node) { if (node.kind === 'project') { if (node.lifecycle !== 'active') break; out.unshift(node.id); } node = node.parentId === null ? undefined : input.get(node.parentId); }
    return ['root', ...out];
  })();
  const pages: Record<string, string[]> = {};
  const addPage = (scope: string, id: string) => { (pages[scope] ??= []).push(id); };
  const scopeIds = new Set(['root', ...all.filter(t => t.kind === 'project' && t.lifecycle === 'active').map(t => t.id), ...all.flatMap(scopes)]);
  const counts = { home: Object.fromEntries([...scopeIds].map(id => [id, homeCounts()])), tasks: Object.fromEntries([...scopeIds].map(id => [id, 0])),
    closed: Object.fromEntries([...scopeIds].map(id => [id, closedCounts()])), all: { turn: 0, running: 0 } };
  const menu = Object.fromEntries([...scopeIds].map(id => [id, { turn: 0, running: 0 }]));
  for (const t of all) {
    const h = home.find(h => h.taskId === t.id), kind = t.lifecycle !== 'active' ? 'shelved' : isFinished(t.state) ? 'finished' : null;
    if (kind === 'finished' && t.parentId !== null && t.parentId !== t.projectId) addPage(closedPageScope(kind, t.parentId, null), t.id);
    for (const scope of scopes(t)) {
      if (h && h.section !== 'done') counts.home[scope]![h.section]++;
      if (t.kind === 'task') counts.tasks[scope]!++;
      if (facts.get(t.id)?.menuRunning ?? t.openRuns.length > 0) menu[scope]!.running++;
      if (kind && (kind === 'shelved' || h?.section === 'done')) {
        addPage(closedPageScope(kind, null, scope === 'root' ? null : scope), t.id);
        counts.closed[scope]![kind]++;
      }
    }
  }
  for (const scope of scopeIds) menu[scope]!.turn = counts.home[scope]!.review;
  counts.all = menu.root!;
  for (const ids of Object.values(pages)) ids.sort(byMoved);
  const usage = (values: Contribution[]): UsageTotal => {
    const out = zeroUsage();
    for (const t of values) {
      out.runs += t.usage.runs; out.runMs += t.usage.runMs; out.tokensUnknown += t.usage.tokensUnknown;
      if (t.usage.tokens) {
        out.tokens ??= { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
        for (const key of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) out.tokens[key] += t.usage.tokens[key];
      }
    }
    return out;
  };
  return { counts, menu, pages, order, tasks: Object.fromEntries(all.map(t => {
    const descendants = below(t.id), runs = descendants.flatMap(c => c.openRuns).sort((a, b) => byTaskNumber({ id: a[0] }, { id: b[0] }));
    return [t.id, { children: counted[t.id], childCounts: { live: counted[t.id]?.live ?? 0, finished: counted[t.id]?.finished ?? 0 },
      movedAt: moved.get(t.id), usageBelow: usage(descendants), runsBelow: runs, runningRuns: runs.length + t.openRuns.length,
      workingBelow: all.filter(c => c.working && ancestors(c.id, true).includes(t.id)).length,
      live: [t, ...descendants].some(c => c.lifecycle === 'active' && !isFinished(c.state)),
      home: home.find(h => h.taskId === t.id), position: placed.find(each => each.taskId === t.id)?.position ?? null, homeAfter: order.includes(t.id) ? order[order.indexOf(t.id) - 1] ?? null : undefined }];
  })) };
}
function observed(frame: AggregateSnapshot, ids: Iterable<string>, pageNames: Iterable<string>) {
  return { counts: frame.counts(), menu: Object.fromEntries(Object.keys(frame.counts().home).map(id => [id, frame.menu(id)])),
    order: [...frame.homeIds()], pages: Object.fromEntries([...pageNames].map(scope => [scope, frame.page(scope)])),
    tasks: Object.fromEntries([...ids].map(id => [id, { children: frame.children(id), childCounts: frame.childCounts(id), movedAt: frame.movedAt(id),
      usageBelow: frame.usageBelow(id), runsBelow: frame.runsBelow(id), runningRuns: frame.runningRuns(id), workingBelow: frame.workingBelow(id),
      live: frame.live(id), home: frame.home(id), position: frame.position(id), homeAfter: frame.homeAfter(id) }])) };
}
function check(frame: AggregateSnapshot, input: ReadonlyMap<string, Contribution>, facts = new Map<string, AggregateFacts>()) {
  const reference = full(input, facts);
  assert.deepEqual(observed(frame, input.keys(), Object.keys(reference.pages)), reference);
}
function replace(frame: AggregateSnapshot, before: Contribution, after: Contribution): AggregateSnapshot {
  return aggregate(frame, new Map([[before.id, { before, after }]])).next as AggregateSnapshot;
}

test('active nesting stops at an inactive parent while logical usage, open runs, movement and live ancestry cross it', () => {
  const values = [task('P1', null, { kind: 'project' }), task('T1', 'P1'), task('T2', 'T1', { lifecycle: 'archived' }),
    task('T3', 'T2', { running: true, working: true, homeWorking: true, movedAt: 20, openRuns: [['R10', 20], ['R2', 10]],
      usage: { runs: 1, runMs: 10, tokensUnknown: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } })];
  const input = new Map(values.map(t => [t.id, t])), frame = createScreenAggregate(values);
  check(frame, input);
  assert.equal(frame.children('T2')?.runningBelow, 1);
  assert.equal(frame.children('T1'), undefined);
  assert.equal(frame.workingBelow('T1'), 0);
  assert.equal(frame.movedAt('P1'), 20);
  assert.deepEqual(frame.runsBelow('P1'), [['R2', 10], ['R10', 20]]);
  const changed = { ...values[3]!, usage: zeroUsage(), movedAt: 1, openRuns: [] };
  input.set(changed.id, changed); const next = replace(frame, values[3]!, changed); check(next, input);
  assert.equal(next.usageBelow('P1').tokens, null);
  assert.equal(next.movedAt('P1'), 1);
  assert.equal(frame.movedAt('P1'), 20);
  assert.deepEqual(frame.usageBelow('P1').tokens, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
});

function random(seed: number) { return (max: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; }; }
test('random batches match a full calculation after each update, including reparenting, personal facts and deleted leaves', () => {
  for (const seed of [7, 39, 812]) {
    const rand = random(seed), input = new Map<string, Contribution>(), facts = new Map<string, AggregateFacts>();
    input.set('P1', task('P1', null, { kind: 'project' }));
    input.set('P2', task('P2', 'P1', { kind: 'project', projectId: 'P2' }));
    for (let i = 1; i <= 24; i++) input.set(`T${i}`, task(`T${i}`, i > 1 && rand(2) ? `T${1 + rand(i - 1)}` : 'P2', { projectId: 'P2' }));
    let frame = createScreenAggregate(input.values()), pages = new Set<string>();
    for (let step = 0; step < 240; step++) {
      const beforeFrame = frame, beforeInput = new Map(input), beforeFacts = new Map(facts);
      const changes = new Map<string, { before: Contribution | undefined; after: Contribution | undefined }>();
      const factChanges = new Map<string, AggregateFacts | undefined>();
      for (let batch = 0; batch < 1 + rand(3); batch++) {
        const index = 1 + rand(24), id = `T${index}`, before = input.get(id);
        if (before && rand(14) === 0 && ![...input.values()].some(t => t.parentId === id)) {
          input.delete(id); facts.delete(id); factChanges.set(id, undefined); changes.set(id, { before: beforeInput.get(id), after: undefined }); continue;
        }
        const state = ['doing', 'todo', 'done', 'stopped', 'waiting', 'held', 'error'][rand(7)]! as Contribution['state'];
        const known = rand(3) === 0, running = rand(3) === 0;
        const after = task(id, index > 1 && rand(2) ? `T${1 + rand(index - 1)}` : 'P2', {
          ...before, parentId: index > 1 && rand(2) ? `T${1 + rand(index - 1)}` : 'P2', projectId: 'P2',
          lifecycle: rand(5) ? 'active' : 'archived', state, baseState: state === 'held' ? 'doing' : state, hold: state === 'held',
          running, working: running || rand(3) === 0, homeWorking: rand(3) === 0, movedAt: rand(100),
          // A user's turn above working Tasks moves their rows, so balls change with the rest.
          ball: rand(4) === 0 ? { holder: 'user', reason: 'question', at: '2026-11-17T00:00:00Z', key: `L${step}`, questionId: `L${step}`,
            aboutRunId: null, count: null, code: null, failure: null } : null,
          openRuns: running ? [[`R${index * 2}`, rand(100)], [`R${index * 2 + 1}`, rand(100)]] : [],
          usage: { runs: 1 + rand(3), runMs: rand(100), tokensUnknown: known ? 0 : 1,
            tokens: known ? { input: rand(3), cacheRead: 0, cacheWrite: 0, output: rand(3) } : null } });
        input.set(id, after); changes.set(id, { before: beforeInput.get(id), after });
        if (rand(5) === 0) { const value = { scopes: ['root', 'P1', 'P2'], listed: rand(4) > 0, menuRunning: !!rand(2) };
          facts.set(id, value); factChanges.set(id, value); }
      }
      const result = updateScreenAggregate(frame, changes, factChanges); frame = result.next;
      const reference = full(input, facts); Object.keys(reference.pages).forEach(scope => pages.add(scope));
      const actual = observed(frame, input.keys(), Object.keys(reference.pages));
      assert.deepEqual(actual, reference, `seed ${seed}, step ${step}`);
      // Old published readers must remain unchanged throughout construction of their successor.
      const oldReference = full(beforeInput, beforeFacts);
      assert.deepEqual(observed(beforeFrame, beforeInput.keys(), Object.keys(oldReference.pages)), oldReference);
      const allIds = new Set([...beforeInput.keys(), ...input.keys()]);
      for (const id of allIds) {
        const old = observed(beforeFrame, [id], []).tasks[id], next = observed(frame, [id], []).tasks[id];
        if (JSON.stringify(old) !== JSON.stringify(next)) assert.ok(result.changed.tasks.has(id), `missing changed task ${id}, seed ${seed}, step ${step}`);
      }
      for (const scope of pages) if (JSON.stringify(beforeFrame.page(scope)) !== JSON.stringify(frame.page(scope)))
        assert.ok(result.changed.pages.has(scope), `missing changed page ${scope}`);
      if (JSON.stringify(beforeFrame.counts()) !== JSON.stringify(frame.counts())) assert.equal(result.changed.counts, true);
    }
  }
});

test('the home list a screen keeps from patches is the whole list after section moves and project listing changes', () => {
  const sections = [{ state: 'doing', homeWorking: true }, { state: 'waiting', baseState: 'waiting' },
    { state: 'waiting', baseState: 'waiting', ball: { holder: 'user', reason: 'question' } }, { state: 'todo', baseState: 'todo' },
    { state: 'error', baseState: 'error' }, { state: 'held', baseState: 'doing', hold: true }, { state: 'done', baseState: 'done' }] as Partial<Contribution>[];
  for (const seed of [3, 908, 4401]) {
    const rand = random(seed), input = new Map<string, Contribution>();
    input.set('P1', task('P1', null, { kind: 'project' }));
    for (const project of ['P2', 'P3']) input.set(project, task(project, 'P1', { kind: 'project', projectId: project }));
    const projectOf = (i: number) => i % 3 === 0 ? 'P3' : 'P2';
    for (let i = 1; i <= 20; i++) input.set(`T${i}`, task(`T${i}`, projectOf(i), { projectId: projectOf(i), ...sections[rand(sections.length)], movedAt: i }));
    let p3Listed = false;
    const factsOf = (id: string): AggregateFacts => ({ scopes: ['root'], listed: input.get(id)!.projectId !== 'P3' || p3Listed,
      menuRunning: false });
    let frame = createScreenAggregate(input.values(), new Map([...input.keys()].map(id => [id, factsOf(id)]))), clock = 100;
    // What the index sends of a row and the whole list it serves, as projection-owner's source.home and index() do.
    const visible = (id: string) => input.get(id)!.projectId !== 'P3' || p3Listed;
    const listed = (id: string) => { const row = frame.home(id), after = frame.homeAfter(id);
      return row && row.section !== 'done' && after !== undefined && visible(id) ? { row, after } : undefined; };
    const whole = () => [...frame.homeIds()].filter(id => listed(id));
    const patcher = new IndexPatcher(), empty = () => ({ upsert: {}, remove: [] });
    const patch = (rev: number, candidates: Iterable<string>) => patcher.patch({ rev, generation: 'g', pv: rev as ProjectionVersion, candidates,
      row: () => undefined, placements: () => [], runs: () => [], children: () => undefined, home: listed,
      counts: null, requiredPv: { view: empty(), history: empty(), page: empty(), timeline: empty(), search: empty() }, meta: {} as never });
    patch(0, input.keys());
    let shown = whole().map(id => listed(id)!.row);
    for (let step = 1; step <= 200; step++) {
      const changes = new Map<string, { before: Contribution | undefined; after: Contribution }>();
      const factChanges = new Map<string, AggregateFacts>();
      if (rand(8) === 0) {
        // The project is taken off the list or put back: every Task in it gets new facts in the same batch.
        p3Listed = !p3Listed;
        for (const [id, value] of input) if (value.projectId === 'P3' && value.kind === 'task') factChanges.set(id, factsOf(id));
      }
      // Several Tasks change section in one batch, as when two finish their turns between two publications.
      for (let n = 0; n < 1 + rand(3); n++) {
        const id = `T${1 + rand(20)}`, before = input.get(id)!;
        const after = task(id, before.parentId, { projectId: before.projectId, ...sections[rand(sections.length)], movedAt: ++clock });
        input.set(id, after); changes.set(id, { before: changes.get(id)?.before ?? before, after });
      }
      const result = updateScreenAggregate(frame, changes, factChanges); frame = result.next;
      const candidates = [...patchCandidates({ tasks: new Map([...changes.keys(), ...factChanges.keys()].map(id => [id, new Set()])) } as never, result.changed)];
      const home = patch(step, rand(2) ? candidates : candidates.reverse())?.home ?? { upsert: [], remove: [] };
      const next = placeHomeRows(shown, home);
      assert.ok(next, `seed ${seed}, step ${step}: every placed row follows a row the screen holds`);
      assert.deepEqual(next.map(row => row.taskId), whole(), `seed ${seed}, step ${step}`);
      shown = next;
    }
  }
});

test('project boundaries stop home work, and changed project ancestry updates default scope counts and closed ordering', () => {
  const values = [task('P1', null, { kind: 'project' }), task('P2', 'P1', { kind: 'project', projectId: 'P2' }),
    task('T1', 'P1'), task('T2', 'T1', { kind: 'project', projectId: 'T2' }), task('T3', 'T2', { projectId: 'T2', homeWorking: true }),
    task('T4', 'P2', { projectId: 'P2', state: 'done', baseState: 'done', movedAt: 50 })];
  const input = new Map(values.map(t => [t.id, t])); let frame = createScreenAggregate(values); check(frame, input);
  assert.equal(frame.home('T1')?.section, 'awaited');
  const after = { ...input.get('P2')!, parentId: null }; input.set(after.id, after); frame = replace(frame, values[1]!, after); check(frame, input);
  assert.equal(frame.counts().closed.P1?.finished, 0); assert.equal(frame.counts().closed.P2?.finished, 1);
});

test('repair rebuilds corrupt totals and membership from current contributions, even with no contribution delta', () => {
  for (const kind of ['aggregate', 'membership', 'order'] as const) {
    const values = [task('P1', null, { kind: 'project' }), task('T1', 'P1', { state: 'done', baseState: 'done', movedAt: 8 }),
      task('T2', 'T1', { movedAt: 30, running: true, working: true, usage: { runs: 2, runMs: 10, tokensUnknown: 2, tokens: null } })];
    const input = new Map(values.map(t => [t.id, t])), frame = createScreenAggregate(values);
    // Inject a cache-value fault, without altering the authoritative contributions or database.
    const internals = frame as unknown as { nodes: { get(id: string): Record<string, unknown> }; scopes: { get(id: string): { root: { total: number[] } } } };
    const node = internals.nodes.get('T1'); Object.assign(node, { belowActive: 991, belowWorking: 992, moved: 999, usage: { runs: 993, runMs: 0, tokens: null, tokensUnknown: 993, knownGroups: 0 } });
    internals.scopes.get('root').root.total[6] = 700;
    if (kind === 'membership') {
      const member = (frame as unknown as { members: { get(id: string): { home: { section: string; summary: { done: number } } } } }).members.get('T1');
      member.home.section = 'todo'; member.home.summary.done = 999;
    }
    if (kind === 'order') {
      // Corrupt a page entry's value while preserving its key and the correct contribution.
      type PageIndex = { set(key: { id: string; at: number; section: number }, value: string): PageIndex };
      type Pages = { get(scope: string): PageIndex; set(scope: string, page: PageIndex): Pages };
      const damaged = frame as unknown as { pages: Pages };
      damaged.pages = damaged.pages.set('finished:root', damaged.pages.get('finished:root').set({ id: 'T1', at: 30, section: 0 }, 'T999'));
      assert.ok(frame.page('finished:root').includes('T999'));
    }
    assert.notEqual(frame.workingBelow('T1'), 1);
    const result = repairScreenAggregate(frame, [{ task: 'T1', kind }]); check(result.next, input);
    assert.ok(result.changed.tasks.has('T1')); assert.ok(result.changed.tasks.has('P1'));
  }
});

test('cycles fail without mutating the published snapshot and no-op updates have no changes', () => {
  const a = task('T1', null), b = task('T2', 'T1'), input = new Map([[a.id, a], [b.id, b]]), frame = createScreenAggregate(input.values());
  assert.throws(() => replace(frame, a, { ...a, parentId: b.id }), /Cyclic aggregate tree/); check(frame, input);
  const noop = aggregate(frame, new Map([[a.id, { before: a, after: { ...a } }]]));
  assert.deepEqual([...noop.changed.tasks], []); assert.deepEqual([...noop.changed.pages], []); assert.equal(noop.changed.counts, false);
});

test('section changes, closed child counts, and running facts follow the same incremental memberships', () => {
  const userBall = { holder: 'user' as const, reason: 'review' as const, at: '2026-11-16T00:00:00Z', key: 'review-1',
    questionId: null, aboutRunId: null, count: null, code: null, failure: null };
  const values = [task('P1', null, { kind: 'project' }), task('T1', 'P1', { state: 'done', baseState: 'done' }),
    task('T2', 'T1', { state: 'done', baseState: 'done' }), task('T3', 'P1', { hold: true, state: 'held', ball: userBall })];
  const input = new Map(values.map(t => [t.id, t])), facts = new Map<string, AggregateFacts>();
  let frame = createScreenAggregate(values); check(frame, input, facts);
  assert.equal(frame.home('T3')?.section, 'held');
  const child = input.get('T2')!, review = { ...child, hold: true, state: 'held' as const, baseState: 'doing' as const, ball: userBall };
  input.set(child.id, review); let result = updateScreenAggregate(frame, new Map([[child.id, { before: child, after: review }]])); frame = result.next;
  check(frame, input, facts); assert.equal(frame.home('T2')?.section, 'held');
  assert.ok(result.changed.pages.has('finished:root')); assert.deepEqual(frame.childCounts('T1'), { live: 1, finished: 0 });
  // Taking the hold off a child awaiting the user's review moves its row and count back to review.
  const reviewCount = (now: typeof frame) => now.counts().home.root?.review ?? 0, heldReview = reviewCount(frame);
  const unheld = { ...review, hold: false, state: 'doing' as const };
  input.set(child.id, unheld); frame = replace(frame, review, unheld); check(frame, input, facts);
  assert.equal(frame.home('T2')?.section, 'review'); assert.equal(reviewCount(frame), heldReview + 1);
  input.set(child.id, review); frame = replace(frame, unheld, review); check(frame, input, facts);
  assert.equal(frame.home('T2')?.section, 'held'); assert.equal(reviewCount(frame), heldReview);
  const fact = { scopes: ['root', 'P1'], listed: true, menuRunning: true }; facts.set('T1', fact);
  result = updateScreenAggregate(frame, new Map(), new Map([['T1', fact]])); frame = result.next; check(frame, input, facts);
  assert.equal(frame.menu('P1').running, 1);
  assert.equal(frame.movedAt('T1'), 0);
  const removed = { ...review, lifecycle: 'deleted' as const }; input.set(removed.id, removed); frame = replace(frame, review, removed);
  check(frame, input, facts); assert.equal(frame.children('T1'), undefined); assert.deepEqual(frame.childCounts('T1'), { live: 0, finished: 0 });
});

test('archiving or relocating an ancestor updates nested projects and leaves archived descendants logically attached', () => {
  const values = [task('P1', null, { kind: 'project' }), task('P2', null, { kind: 'project', projectId: 'P2' }),
    task('T1', 'P1'), task('P3', 'T1', { kind: 'project', projectId: 'P3' }),
    task('T2', 'P3', { projectId: 'P3', state: 'done', baseState: 'done' })];
  const input = new Map(values.map(t => [t.id, t])); let frame = createScreenAggregate(values); check(frame, input);
  for (const [id, patch] of [['T1', { parentId: 'P2', projectId: 'P2' }], ['P2', { lifecycle: 'archived' }], ['P2', { lifecycle: 'active' }]] as const) {
    const before = input.get(id)!, after = { ...before, ...patch }; input.set(id, after); frame = replace(frame, before, after); check(frame, input);
  }
});

test('moving an open Run between a Task and its child marks the changed runsBelow even if the total Run set stays the same', () => {
  const a = task('T1', null, { openRuns: [['R1', 1]] }), b = task('T2', a.id), frame = createScreenAggregate([a, b]);
  const afterA = { ...a, openRuns: [] }, afterB = { ...b, openRuns: a.openRuns };
  const result = updateScreenAggregate(frame, new Map([[a.id, { before: a, after: afterA }], [b.id, { before: b, after: afterB }]]));
  check(result.next, new Map([[a.id, afterA], [b.id, afterB]]));
  assert.ok(result.changed.tasks.has(a.id)); assert.deepEqual(result.next.runsBelow(a.id), [['R1', 1]]);
});
