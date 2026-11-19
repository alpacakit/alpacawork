/** Acceptance through the shipped evaluator and actual Query identities. No test evaluator. */
import { afterEach, expect, test, vi } from 'vitest';
import { dehydrate, hydrate, QueryClient } from '@tanstack/react-query';
import { taskViewSchema, type TaskViewDTO } from '@alpacawork/contract/control';
import { captureReadProof, evaluateRead, getReadProof, observeReadProofs, recordReadProof } from '../src/data/read-model';
import { requestRead } from '../src/data/read-demand';
import { resources, assessRead, receiveFullIndex, showWrittenTask } from '../src/data/resources';
import { headOf, dto, indexOf, tree, viewsOf } from './fixtures';

const clients: QueryClient[] = [];
afterEach(() => { clients.forEach(client => client.clear()); clients.length = 0; vi.restoreAllMocks(); });
function fixture() {
  const source = tree({ tasks: [dto({ id: 'T1' }), dto({ id: 'T2' })] });
  const index = indexOf(source), view = viewsOf(source).find(view => view.task.id === 'T1')!;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client); receiveFullIndex(client, index);
  const key = ['task', index.root, 'T1'] as const;
  function install(data: unknown = view, id = 'T1') {
    const key = ['task', index.root, id] as const;
    client.setQueryData(key, data);
    const query = client.getQueryCache().find({ queryKey: key, exact: true })!;
    recordReadProof(query, captureReadProof(index, key));
    return query;
  }
  return { client, index, view, key, install };
}

test('identical payload under a different full Task key is never certified', () => {
  const f = fixture(), first = f.install();
  expect(assessRead(f.client, first).state).toBe('current');
  const other = f.install(first.state.data, 'T2');
  expect(other.state.data).toBe(first.state.data);
  expect(assessRead(f.client, other)).toMatchObject({ state: 'invalid', display: false, project: false, persist: false });
});

test('a corrupt replacement invalidates an already inspected Query', () => {
  const f = fixture(), q = f.install(); expect(assessRead(f.client, q).state).toBe('current');
  f.client.setQueryData(f.key, { ...f.view, task: { ...f.view.task, id: 'T2' } });
  recordReadProof(q, captureReadProof(f.index, f.key));
  expect(assessRead(f.client, q).state).toBe('invalid');
});

test('shared data in a separate client cannot borrow the first client proof or scope', () => {
  const a = fixture(), q = a.install(); expect(assessRead(a.client, q).state).toBe('current');
  const b = fixture(); b.client.setQueryData(b.key, q.state.data);
  const other = b.client.getQueryCache().find({ queryKey: b.key, exact: true })!;
  expect(other).not.toBe(q); expect(getReadProof(other)).toBeUndefined();
  expect(assessRead(b.client, other).project).toBe(false);
  recordReadProof(other, captureReadProof({ ...b.index, generation: 'other' }, b.key));
  expect(assessRead(b.client, other).state).toBe('invalid');
});

test('standard hydrate does not borrow Query proof; restoration proof still passes the same structural boundary', () => {
  const a = fixture(), q = a.install(); expect(assessRead(a.client, q).state).toBe('current');
  const b = fixture(); hydrate(b.client, JSON.parse(JSON.stringify(dehydrate(a.client))));
  const other = b.client.getQueryCache().find({ queryKey: b.key, exact: true })!;
  expect(assessRead(b.client, other).project).toBe(false);
  recordReadProof(other, captureReadProof(b.index, b.key));
  expect(assessRead(b.client, other).state).toBe('current');
  expect(Object.isFrozen((other.state.data as TaskViewDTO).task)).toBe(true);
});

test('structuralSharing preserves unchanged children and validates a changed immutable value', () => {
  const f = fixture(), q = f.install(); expect(assessRead(f.client, q).state).toBe('current');
  const before = q.state.data as TaskViewDTO;
  f.client.setQueryData(f.key, JSON.parse(JSON.stringify(before)));
  expect(q.state.data).toBe(before);
  f.client.setQueryData(f.key, { ...before, task: { ...before.task, values: { notes: 'new immutable body' } } });
  expect((q.state.data as TaskViewDTO).placements).toBe(before.placements);
  recordReadProof(q, captureReadProof(f.index, f.key));
  expect(assessRead(f.client, q).state).toBe('current');
  expect((q.state.data as TaskViewDTO).task.values?.notes).toBe('new immutable body');
  expect(Object.isFrozen((q.state.data as TaskViewDTO).task)).toBe(true);
});

test('standard cancellation/revert keeps the original data and re-evaluates it', async () => {
  const f = fixture(); observeReadProofs(f.client);
  const q = f.install(); expect(assessRead(f.client, q).state).toBe('current'); const before = q.state.data;
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const fetch = f.client.fetchQuery({ queryKey: f.key, staleTime: 0, queryFn: ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); started();
  }) }).catch(() => undefined);
  await ready; await f.client.cancelQueries({ queryKey: f.key, exact: true }, { revert: true }); await fetch;
  expect(q.state.data).toBe(before); expect(q.state.fetchStatus).toBe('idle');
  expect(assessRead(f.client, q).display).toBe(true);
  expect(Object.isFrozen((q.state.data as TaskViewDTO).task)).toBe(true);
});

test('real receipt installs an immutable new view without claiming a completed read', () => {
  const f = fixture(); observeReadProofs(f.client); const q = f.install();
  expect(assessRead(f.client, q).state).toBe('current');
  const before = q.state.data;
  showWrittenTask(f.client, headOf({ ...f.view.task, version: f.view.task.version + 1, values: { notes: 'receipt body' } }), f.index);
  expect(q.state.data).not.toBe(before);
  expect((q.state.data as TaskViewDTO).task.values?.notes).toBe('receipt body');
  expect(assessRead(f.client, q)).toMatchObject({ state: 'unverified', display: true, project: false });
  expect(Object.isFrozen((q.state.data as TaskViewDTO).task)).toBe(true);
});

test.each(['remove', 'clear'] as const)('%s ends Query identity and cannot lend its proof to the replacement', mode => {
  const f = fixture(), old = f.install(); expect(assessRead(f.client, old).state).toBe('current');
  const data = old.state.data;
  if (mode === 'clear') { f.client.clear(); receiveFullIndex(f.client, f.index); }
  else f.client.removeQueries({ queryKey: f.key, exact: true });
  f.client.setQueryData(f.key, data);
  const next = f.client.getQueryCache().find({ queryKey: f.key, exact: true })!;
  expect(next).not.toBe(old); expect(getReadProof(next)).toBeUndefined(); expect(assessRead(f.client, next).project).toBe(false);
  recordReadProof(next, captureReadProof(f.index, f.key)); expect(assessRead(f.client, next).state).toBe('current');
});

test.each([false, true])('validated JSON DTO forbids deep in-place mutation, shallow parent freeze=%s', shallow => {
  const f = fixture(); if (shallow) Object.freeze(f.view);
  const q = f.install(); expect(assessRead(f.client, q).state).toBe('current');
  const data = q.state.data as TaskViewDTO, before = data.task.values;
  expect(() => { data.task.values = { notes: 'silently corrupt memo' }; }).toThrow(TypeError);
  expect(data.task.values).toBe(before);
  expect(Object.isFrozen(data)).toBe(true); expect(Object.isFrozen(data.task.log)).toBe(true);
  expect(Object.isFrozen(data.task.log[0])).toBe(true);
});

const nonJsonCases: [string, () => unknown][] = [
  ['Map', () => new Map([['x', 1]])], ['Date', () => new Date(0)], ['function', () => () => 1],
  ['undefined', () => undefined], ['nonfinite', () => NaN], ['cycle', () => { const v: any = {}; v.self = v; return v; }],
];
test.each(nonJsonCases)('non-JSON %s cannot be certified by a shape memo', (_name, extra) => {
  const f = fixture(), q = f.install({ ...f.view, extension: extra() });
  try { expect(assessRead(f.client, q)).toMatchObject({ state: 'invalid', display: false, project: false, persist: false }); }
  finally { f.client.clear(); } // Invalid raw input must not reach an unrelated asynchronous retention sweep.
});

test.each(['custom-prototype', 'null-parent-custom-prototype', 'accessor'] as const)('schema-shaped non-JSON %s cannot become structural evidence', kind => {
  const f = fixture();
  if (kind === 'custom-prototype') Object.setPrototypeOf(f.view.task, { nonDtoMethod() { return 'mutable implementation'; } });
  else if (kind === 'null-parent-custom-prototype') {
    const prototype = Object.assign(Object.create(null), { body: f.view.task.values });
    delete (f.view.task as Partial<typeof f.view.task>).values;
    Object.setPrototypeOf(f.view.task, prototype); // Freezing the DTO would not freeze its inherited body.
  }
  else Object.defineProperty(f.view.task, 'body', { get: () => 'accessor body', enumerable: true, configurable: true });
  const q = f.install();
  try { expect(assessRead(f.client, q)).toMatchObject({ state: 'invalid', display: false, project: false, persist: false }); }
  finally { f.client.clear(); }
});

test.each(['null-prototype', 'cross-realm'] as const)('plain JSON %s still becomes immutable structural evidence', kind => {
  const f = fixture(), data = kind === 'cross-realm' ? structuredClone(f.view) : f.view;
  if (kind === 'null-prototype') Object.setPrototypeOf(data.task, null);
  else expect(Object.getPrototypeOf(data)).not.toBe(Object.prototype);
  const q = f.install(data);
  expect(assessRead(f.client, q).state).toBe('current');
  expect(Object.isFrozen((q.state.data as TaskViewDTO).task)).toBe(true);
});

test('the full semantic key cannot be mutated after structural certification', () => {
  const f = fixture(), q = f.install(); expect(assessRead(f.client, q).state).toBe('current');
  expect(() => { (q.queryKey as unknown[])[2] = 'T2'; }).toThrow(TypeError);
  expect(q.queryKey).toEqual(f.key);
});

test('unchanged data is parsed once, not once per notification or caller', () => {
  const f = fixture(), q = f.install();
  // Observe the actual nested schema entry, not a test evaluator or inferred listener count.
  const parse = vi.spyOn(taskViewSchema.shape.task._zod, 'run');
  expect(assessRead(f.client, q).state).toBe('current'); expect(parse).toHaveBeenCalledTimes(1);
  parse.mockClear();
  for (let n = 0; n < 5; n++) { q.setState({}); for (let caller = 0; caller < 4; caller++) expect(assessRead(f.client, q).state).toBe('current'); }
  expect(parse).toHaveBeenCalledTimes(0);
});

test('an unchanged Query reuses its frozen semantic key without scanning the parts again', () => {
  const f = fixture(), q = f.install();
  expect(assessRead(f.client, q).state).toBe('current');
  const every = Array.prototype.every; let scans = 0;
  vi.spyOn(Array.prototype, 'every').mockImplementation(function (this: unknown[], ...args: any[]) {
    if (this === q.queryKey) scans++;
    return (every as any).apply(this, args);
  });
  for (let n = 0; n < 20; n++) expect(assessRead(f.client, q).state).toBe('current');
  expect(scans).toBe(0);
});

test('a valid changed payload passes the actual structural schema again', () => {
  const f = fixture(), q = f.install(); expect(assessRead(f.client, q).state).toBe('current');
  const parse = vi.spyOn(taskViewSchema.shape.task._zod, 'run');
  f.client.setQueryData(f.key, { ...f.view, task: { ...f.view.task, values: { notes: 'changed' } } });
  recordReadProof(q, captureReadProof(f.index, f.key));
  expect(assessRead(f.client, q).state).toBe('current'); expect(parse).toHaveBeenCalledTimes(1);
});

test.each(['other-client', 'remove', 'clear'] as const)('immutable structure survives %s without borrowing Query qualification', mode => {
  const a = fixture(), old = a.install(); expect(assessRead(a.client, old).state).toBe('current');
  const data = old.state.data;
  if (mode === 'remove') a.client.removeQueries({ queryKey: a.key, exact: true });
  if (mode === 'clear') { a.client.clear(); receiveFullIndex(a.client, a.index); }
  const b = mode === 'other-client' ? fixture() : a;
  const next = b.install(data); expect(next).not.toBe(old);
  const parse = vi.spyOn(taskViewSchema.shape.task._zod, 'run');
  expect(assessRead(b.client, next).state).toBe('current'); expect(parse).toHaveBeenCalledTimes(0);
});

test('checkpoint slots validate each immutable value once across repeated qualification', () => {
  const f = fixture(), data = JSON.parse(JSON.stringify(f.view));
  const key = [...f.key], proof = captureReadProof(f.index, key);
  const parse = vi.spyOn(taskViewSchema.shape.task._zod, 'run');
  const read = { key, data, proof };
  expect(evaluateRead(f.index, read).state).toBe('current');
  expect(parse).toHaveBeenCalledTimes(1); parse.mockClear();
  for (let n = 0; n < 5; n++) expect(evaluateRead(f.index, { ...read, key: [...key] }).state).toBe('current');
  expect(parse).toHaveBeenCalledTimes(0);
  expect(evaluateRead({ ...f.index, generation: 'replaced' }, read).state).toBe('invalid');
  expect(evaluateRead(f.index, { ...read, refused: true }).state).toBe('refused');
  key[2] = 'T2';
  expect(evaluateRead(f.index, read).state).toBe('invalid');
  expect(Object.isFrozen(data.task)).toBe(true);
});

test('reusing structure never reuses current qualification across demand or generation changes', async () => {
  const f = fixture(), q = f.install(); expect(assessRead(f.client, q).state).toBe('current');
  requestRead(q); expect(assessRead(f.client, q)).toMatchObject({ state: 'unverified', display: true, project: false });
  recordReadProof(q, captureReadProof(f.index, f.key)); expect(assessRead(f.client, q).state).toBe('unverified');
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(q.state.data));
  await f.client.fetchQuery({ ...resources.taskView(f.index.root, 'T1'), staleTime: 0 }); expect(assessRead(f.client, q).state).toBe('current');
  f.client.setQueryData(['index'], { ...f.index, generation: 'replaced' });
  expect(assessRead(f.client, q).state).toBe('invalid');
});

test.each(['subclass', 'prototype', 'hole-with-property'] as const)('non-JSON array %s cannot be certified through an otherwise valid DTO', kind => {
  const f = fixture();
  const extra: any[] = kind === 'subclass' ? new (class CustomArray extends Array {})() : [];
  if (kind === 'prototype') Object.setPrototypeOf(extra, { customMethod() {} });
  if (kind === 'hole-with-property') { extra.length = 2; extra[0] = 'one'; Object.defineProperty(extra, 'extension', { value: 'two', enumerable: true }); }
  const q = f.install({ ...f.view, placements: extra });
  try { expect(assessRead(f.client, q)).toMatchObject({ state: 'invalid', display: false, persist: false }); }
  finally { f.client.clear(); }
});
