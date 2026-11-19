import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitTitle, formatReportDiff, parseReportDiff, pinnedDiffCommand, reportDiffHead, type ReportDiff } from '@alpacawork/contract/report-diff';

const diff: ReportDiff = {
  source: { command: 'git -C /r diff a..b', repo: '/r', base: { sha: 'a'.repeat(40), written: 'a' },
    head: { sha: 'b'.repeat(40), written: 'b' }, paths: [] },
  commits: null,
  files: [{ path: 'x\ty.md', oldPath: null, change: 'modified', added: 1, deleted: 0, kept: true }, { path: 'img.png', oldPath: null, change: 'added', added: null, deleted: null, kept: false }],
  patch: 'diff --git a/x b/x\n+# heading\n',
};

test('a report diff reads back as written, the patch untouched even where it starts with #', () => {
  assert.deepEqual(parseReportDiff(formatReportDiff(diff)), diff);
});

test('a report diff with the commits it holds reads back as written; one written without them has none', () => {
  const named: ReportDiff = { ...diff, commits: { title: 'Merge T4: docs', total: 3,
    list: [{ sha: 'c'.repeat(40), date: '2026-11-01T10:00:00+09:00', subject: 'docs: fix' }] } };
  assert.deepEqual(parseReportDiff(formatReportDiff(named)), named);
  assert.equal(parseReportDiff(formatReportDiff(diff))?.commits, null);
  // A commit line outside its commits, or after the files, is a header this version cannot read.
  assert.equal(parseReportDiff(formatReportDiff(named).replace(/# commits .*\n/, '')), null);
});

test('a commit subject loses the task IDs at its start or alone in brackets, never one in its sentence', () => {
  for (const [subject, shown] of [
    ['Merge T4: Japanese user documentation', 'Japanese user documentation'], ['Merge: the screen language', 'the screen language'],
    ['T38: setup', 'setup'], ['setup.md: おすすめ (T38 点検2)', 'setup.md: おすすめ (点検2)'],
    ['betterquality: 分離 (T39)', 'betterquality: 分離'], ['…にする（T71）', '…にする'],
    ['docs: T154 follows T153', 'docs: T154 follows T153'], ['fix(web): x (review)', 'fix(web): x (review)'],
  ]) assert.equal(commitTitle(subject), shown);
});

test('the copied command shows the diff by the commits it compared, whatever its own command named', () => {
  const source = { ...diff.source, command: 'git diff main...t76/x -- docs', repo: '/my repo', paths: ['docs', "it's"] };
  assert.equal(pinnedDiffCommand(source), `git -C '/my repo' diff ${'a'.repeat(40)}..${'b'.repeat(40)} -- docs 'it'\\''s'`);
});

test('a patch without the header, or a header this version cannot read, is not a report diff', () => {
  assert.equal(parseReportDiff(diff.patch), null);
  const text = formatReportDiff(diff);
  assert.equal(parseReportDiff(text.replace('# file {', '# shape {')), null);
  assert.equal(parseReportDiff(text.replace('"kept":true', '"kept":"yes"')), null);
  assert.equal(parseReportDiff(text.replace('"change":"added"', '"change":"new"')), null);
  assert.equal(parseReportDiff(text.replace(/# source .*\n/, '')), null);
});

test('a report diff\'s head is its header without the patch', () => {
  const text = formatReportDiff(diff);
  assert.equal(reportDiffHead(text), text.slice(0, text.indexOf('diff --git')));
  assert.deepEqual(parseReportDiff(reportDiffHead(text)), { ...diff, patch: '' });
  assert.equal(reportDiffHead(diff.patch), '');
});
