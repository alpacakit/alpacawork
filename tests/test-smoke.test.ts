import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listedCases, smokeSelection, checkSelection } from '../scripts/test-smoke.ts';

const report = { errors: [], suites: [{ title: 'flow.check.ts', specs: [], suites: [{ title: 'phone', specs: [
  { id: 'choice', file: 'flow.check.ts', title: 'answers once', tests: [{ projectName: '', expectedStatus: 'passed' }] },
  { id: 'review', file: 'flow.check.ts', title: 'approves once', tests: [{ projectName: '', expectedStatus: 'passed' }] },
] }] }] };
const manifest = '# native Playwright test-list\nflow.check.ts › phone › answers once\n';

test('native titles preserve full describe path and union smoke/related without duplicate execution', () => {
  const cases = listedCases(report);
  assert.equal(cases[0]!.selector, 'flow.check.ts › phone › answers once');
  assert.deepEqual(smokeSelection(cases, manifest), [cases[0]]);
  assert.deepEqual(smokeSelection(cases, manifest, ['e2e/flow.check.ts', 'e2e/flow.check.ts']), cases);
  checkSelection(cases, [...cases].reverse());
});

test('an area selects its own cases and those of its sub-areas, and only those', () => {
  const inProjects = { errors: [], suites: [{ title: 'flow.check.ts', specs: ['reader-answer', 'reader-view', 'readers', 'list'].map(projectName => (
    { id: projectName, file: 'flow.check.ts', title: projectName, tests: [{ projectName, expectedStatus: 'passed' }] })) }] };
  const cases = listedCases(inProjects);
  const manifest = 'flow.check.ts › list\n';
  const ids = (related: string[]) => smokeSelection(cases, manifest, related).map(c => c.id);
  assert.deepEqual(ids(['reader-view']), ['list', 'reader-view']);
  assert.deepEqual(ids(['reader']), ['list', 'reader-answer', 'reader-view']);
  assert.throws(() => ids(['read']), /area has no cases/);
});

test('smoke rejects zero collection, collection faults, removed titles, duplicate or skipped entries', () => {
  const cases = listedCases(report);
  assert.throws(() => listedCases({ errors: [], suites: [] }), /must not be empty/);
  assert.throws(() => listedCases({ ...report, errors: ['bad import'] }), /collection errors/);
  assert.throws(() => listedCases({ ...report, suites: [...report.suites, ...report.suites] }), /duplicate browser IDs/);
  assert.throws(() => smokeSelection(cases, ''), /must not be empty/);
  assert.throws(() => smokeSelection(cases, manifest + manifest), /duplicate smoke entries/);
  assert.throws(() => smokeSelection(cases, manifest.replace('answers once', 'removed')), /must exist exactly once/);
  assert.throws(() => smokeSelection([...cases, { ...cases[0]!, id: 'duplicate-title' }], manifest), /must exist exactly once/);
  assert.throws(() => smokeSelection([{ ...cases[0]!, expectedStatus: 'skipped' }], manifest), /must be runnable/);
  assert.throws(() => smokeSelection(cases, manifest, ['e2e/missing.check.ts']), /has no cases/);
});

test('the actual native selection must reject missing, extra, duplicate and changed cases', () => {
  const cases = listedCases(report);
  assert.throws(() => checkSelection(cases.slice(1), cases), /no missing/);
  assert.throws(() => checkSelection([...cases, { ...cases[0]!, id: 'extra' }], cases), /no missing/);
  assert.throws(() => checkSelection([cases[0]!, cases[0]!], cases), /no missing/);
  assert.throws(() => checkSelection([{ ...cases[0]!, expectedStatus: 'skipped' }, cases[1]!], cases), /no missing/);
  assert.throws(() => checkSelection(cases, []), /must not be empty/);
});


test('anonymous describe groups contribute no empty segment to the native test-list selector', () => {
  const anonymous = { errors: [], suites: [{ title: 'history.check.ts', suites: [{ title: '', specs: [
    { id: 'history', file: 'history.check.ts', title: 'older reports', tests: [{ projectName: '', expectedStatus: 'passed' }] },
  ] }] }] };
  assert.equal(listedCases(anonymous)[0]!.selector, 'history.check.ts › older reports');
});
