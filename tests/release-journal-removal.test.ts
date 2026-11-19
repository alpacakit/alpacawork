/** Journal/locator retirement is fail-closed and can resume between its two durable removals. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { assertFinishedJournalRemoval, removeFinishedJournal, saveJournal, workspaceJournal, type SwitchJournal } from '@alpacawork/backend/test-dist/release/journal.js';
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'journal-removal-'));
  const place = { workspace: join(root, 'data'), releases: join(root, 'releases') };
  mkdirSync(join(place.workspace, '.alpacawork'), { recursive: true }); mkdirSync(place.releases);
  const journal: SwitchJournal = { version: 4, skillsWriteStarted: false, opId: 'synthetic-operation', workspace: place.workspace,
    target: join(place.releases, 'a'.repeat(40)), old: null, previous: null, phase: 'committed', schema: null };
  const locator = join(place.workspace, '.alpacawork/release-location.json'), file = join(place.releases, 'switch.json');
  t.after(() => { chmodSync(place.releases, 0o700); rmSync(root, { recursive: true, force: true }); });
  return { place, journal, locator, file };
}
test('removing finished operations detaches only their locator and journal, and repeats safely', t => {
  const f = fixture(t), own = join(f.place.workspace, 'notes.txt'); writeFileSync(own, 'synthetic user content');
  for (const phase of ['committed', 'aborted', 'recovered'] as const) {
    saveJournal(f.place, { ...f.journal, phase }); assertFinishedJournalRemoval(f.place);
    removeFinishedJournal(f.place);
    assert.equal(existsSync(f.locator), false); assert.equal(existsSync(f.file), false);
    assert.equal(workspaceJournal(f.place.workspace), null);
    assert.equal(readFileSync(own, 'utf8'), 'synthetic user content');
    removeFinishedJournal(f.place);
  }
});
test('unknown, unfinished and differently owned journals are refused without changing either reference', t => {
  for (const fault of ['missing', 'corrupt', 'unsupported', 'unfinished', 'other-releases', 'other-workspace', 'corrupt-locator'] as const) {
    const f = fixture(t); saveJournal(f.place, f.journal);
    if (fault === 'missing') rmSync(f.file);
    if (fault === 'corrupt') writeFileSync(f.file, '{');
    if (fault === 'unsupported') writeFileSync(f.file, JSON.stringify({ ...f.journal, version: 999 }));
    if (fault === 'unfinished') saveJournal(f.place, { ...f.journal, phase: 'old_stopped' });
    if (fault === 'other-releases') writeFileSync(f.locator, JSON.stringify({ releases: tmpdir() }));
    if (fault === 'other-workspace') writeFileSync(f.file, JSON.stringify({ ...f.journal, workspace: '/synthetic/other' }));
    if (fault === 'corrupt-locator') writeFileSync(f.locator, '{');
    const snapshot = () => [f.locator, f.file].map(file => existsSync(file) ? readFileSync(file).toString('hex') : null);
    const before = snapshot();
    assert.throws(() => assertFinishedJournalRemoval(f.place), undefined, fault);
    assert.throws(() => removeFinishedJournal(f.place), undefined, fault);
    assert.deepEqual(snapshot(), before, fault);
  }
});
test('a failure after detaching the locator leaves a finished journal that removal can resume', { skip: process.getuid?.() === 0 && 'root can remove read-only entries' }, t => {
  const f = fixture(t); saveJournal(f.place, f.journal);
  chmodSync(f.place.releases, 0o500);
  assert.throws(() => removeFinishedJournal(f.place), /EACCES|EPERM/);
  assert.equal(existsSync(f.locator), false); assert.equal(existsSync(f.file), true);
  assert.equal(workspaceJournal(f.place.workspace), null);
  chmodSync(f.place.releases, 0o700);
  removeFinishedJournal(f.place);
  assert.deepEqual(readdirSync(f.place.releases), []);
});
