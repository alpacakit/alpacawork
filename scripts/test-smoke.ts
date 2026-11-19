/** Validate the fixed native Playwright test list before any smoke execution. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Spec = { id: string; title: string; file: string; tests: { projectName: string; expectedStatus: string }[] };
type Suite = { title: string; specs?: Spec[]; suites?: Suite[] };
type Report = { errors: unknown[]; suites: Suite[] };
export type BrowserCase = { id: string; file: string; selector: string; project: string; expectedStatus: string };

export function listedCases(report: Report): BrowserCase[] {
  assert.deepEqual(report.errors, [], 'Playwright collection errors');
  const cases: BrowserCase[] = [];
  function walk(suite: Suite, parents: string[]) {
    const path = [...parents, suite.title];
    for (const spec of suite.specs ?? []) for (const test of spec.tests) {
      cases.push({ id: spec.id, file: spec.file, selector: [spec.file, ...path.slice(1).filter(Boolean), spec.title].join(' › '), project: test.projectName, expectedStatus: test.expectedStatus });
    }
    for (const child of suite.suites ?? []) walk(child, path);
  }
  for (const suite of report.suites) walk(suite, []);
  assert.ok(cases.length, 'browser collection must not be empty');
  assert.equal(new Set(cases.map(c => c.id)).size, cases.length, 'duplicate browser IDs');
  return cases;
}

export function smokeSelection(cases: BrowserCase[], manifest: string, related: string[] = []): BrowserCase[] {
  const lines = manifest.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.ok(lines.length, 'smoke manifest must not be empty');
  assert.equal(new Set(lines).size, lines.length, 'duplicate smoke entries');
  const selected = new Map<string, BrowserCase>();
  for (const line of lines) {
    const matches = cases.filter(c => c.selector === line);
    assert.equal(matches.length, 1, `smoke case must exist exactly once: ${line}`);
    assert.equal(matches[0]!.expectedStatus, 'passed', `smoke case must be runnable: ${line}`);
    selected.set(matches[0]!.id, matches[0]!);
  }
  // A related item is a file (e2e/hold.check.ts) or an area with its sub-areas (coordinator, coordinator-input).
  for (const item of related) {
    const matches = item.startsWith('e2e/')
      ? cases.filter(c => c.file === item.replace(/^e2e\//, ''))
      : cases.filter(c => c.project === item || c.project.startsWith(item + '-'));
    assert.ok(matches.length, `related browser ${item.startsWith('e2e/') ? 'file' : 'area'} has no cases: ${item}`);
    for (const c of matches) selected.set(c.id, c);
  }
  return [...selected.values()];
}

export function checkSelection(actual: BrowserCase[], expected: BrowserCase[]) {
  assert.ok(expected.length, 'expected browser selection must not be empty');
  assert.equal(new Set(expected.map(c => c.id)).size, expected.length, 'duplicate expected browser IDs');
  assert.deepEqual([...actual].sort((a, b) => a.id.localeCompare(b.id)), [...expected].sort((a, b) => a.id.localeCompare(b.id)),
    'native Playwright selection must have no missing, extra, duplicate, or changed cases');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, ...related] = process.argv.slice(2);
  assert.ok(directory && ['prepare', 'check'].includes(command!), 'usage: node scripts/test-smoke.ts prepare|check RUN_DIR [e2e/FILE.check.ts | AREA ...]');
  const read = (name: string) => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
  if (command === 'prepare') {
    const cases = listedCases(read('browser-list.json'));
    const selected = smokeSelection(cases, readFileSync(new URL('./test-smoke.txt', import.meta.url), 'utf8'), related);
    writeFileSync(resolve(directory, 'browser-expected.json'), JSON.stringify(selected, null, 2) + '\n');
    writeFileSync(resolve(directory, 'browser-selection.txt'), selected.map(c => c.selector).join('\n') + '\n');
    console.log(`Selected ${selected.length} unique browser cases from ${cases.length} (smoke plus explicit related files and areas).`);
  } else {
    const actual = listedCases(read('browser-selected.json'));
    checkSelection(actual, read('browser-expected.json'));
    console.log(`Verified ${actual.length} native Playwright selections: missing 0, extra 0, duplicate 0.`);
  }
}
