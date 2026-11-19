import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changelogSection, createReleaseNotes } from '../scripts/release-notes.ts';

test('the current version has release notes in CHANGELOG.md', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const instruction = `Add a non-empty ## ${version} section at the top of CHANGELOG.md, following the writing instructions in its opening comment.`;
  let changelog: string;
  try { changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'); }
  catch (error) { assert.fail(`${instruction}\n${error}`); }
  assert.ok(changelogSection(changelog, version)?.replace(/^#{1,6}\s+.*$/gm, '').trim(), instruction);
});

test('release notes shorten all PRs, credit multiple authors, omit the version PR and signal a missing section', t => {
  const changelog = '# Changelog\n<!--\n## 1.2.3\nNot release text.\n-->\n## 1.2.3\nA useful update.\n\n### Fixes\n- A fix.\n\n## 1.2.2\nOlder notes.\n';
  const generated = [
    "## What's Changed",
    '* First change by @alice in https://github.com/example/project/pull/10',
    '* fix(web): Second change by @alice in https://github.com/example/project/pull/11',
    '* Release version by @publisher in https://github.com/example/project/pull/12',
    '', '## New Contributors',
    '* @alice made their first contribution in https://github.com/example/project/pull/10',
    '* An unfamiliar line remains intact', '',
    '**Full Changelog**: https://github.com/example/project/compare/v1.2.2...v1.2.3',
  ].join('\n');
  const notes = createReleaseNotes(changelog, '1.2.3', generated, '12')!;
  assert.ok(notes.startsWith('A useful update.\n\n### Fixes\n- A fix.\n\n<details><summary>All 2 pull requests</summary>'));
  assert.ok(notes.includes('- First change ([#10](https://github.com/example/project/pull/10))'));
  assert.ok(notes.includes('- Second change ([#11](https://github.com/example/project/pull/11))'));
  assert.doesNotMatch(notes, / by @|Release version|Older notes|Not release text|What's Changed|fix\(web\)/);
  assert.ok(notes.includes('## New Contributors\n* @alice made their first contribution in https://github.com/example/project/pull/10\n* An unfamiliar line remains intact'));
  assert.ok(notes.endsWith('</details>\n\n**Full Changelog**: https://github.com/example/project/compare/v1.2.2...v1.2.3\n'));

  const multiple = createReleaseNotes(changelog, '1.2.3', generated.replace('Second change by @alice', 'Second change by @dependabot[bot]'), '12')!;
  assert.ok(multiple.includes('- First change by @alice ([#10](https://github.com/example/project/pull/10))'));
  assert.ok(multiple.includes('- Second change by @dependabot[bot] ([#11](https://github.com/example/project/pull/11))'));
  assert.match(createReleaseNotes(changelog, '1.2.3', generated)!, /All 3 pull requests/);
  assert.equal(createReleaseNotes(changelog, '1.2', generated), null);

  const root = mkdtempSync(join(tmpdir(), 'release-notes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const changelogPath = join(root, 'CHANGELOG.md'), generatedPath = join(root, 'generated.md');
  writeFileSync(changelogPath, changelog); writeFileSync(generatedPath, generated);
  const run = (version: string) => spawnSync(process.execPath,
    [new URL('../scripts/release-notes.ts', import.meta.url).pathname, changelogPath, version, generatedPath, '12'],
    { encoding: 'utf8', timeout: 10000 });
  const present = run('1.2.3');
  assert.equal(present.status, 0, present.stderr); assert.equal(present.stdout, notes);
  const absent = run('1.2.2-old');
  assert.equal(absent.status, 3, absent.stderr); assert.equal(absent.stdout, ''); assert.equal(absent.stderr, '');
});
