import { commandFetch as fetch } from '../tests/helpers/command-fetch.ts';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cliSync, cleanCliEnv } from '../tests/helpers/http-cli.ts';
import { formatReportDiff, parseReportDiff, type ReportDiff } from '@alpacawork/contract/report-diff';
import { publishFixtureFiles, writeFixtureConfig } from './fixture-writes.ts';
import { parse, stringify } from 'yaml';
import { SAMPLE_PROJECT } from './fixture/sample.ts';
import { seedReview, taskFolder } from './fixture/task-state.ts';
import { test, expect, open, settleMotion, swipe, touch } from './fixtures.ts';

test.use({ isolated: true, locale: 'ja-JP' });

/**
 * The diffs a report attached (the CLI's `diffs/<hex>.diff`, embedded as `![diff](…)`) read on a phone, in
 * Japanese: in the report only their summary, in place of the command block, the report going on under it and no row
 * read; opened, the diff over the whole screen, its files by folder; a file opened under a head that stays while it is
 * read, a document by its changed words and code by its numbered rows.
 */
// Fictional Japanese catalog documents, independent of project conversations and changes.
const PARAGRAPH = 'この図鑑に載せる植物は、色と形を組み合わせて作った架空の見本である。葉の説明には図の番号を付け、花の説明には季節の名前を添える。' +
  '見本の説明は短い段落に分ける。図と説明を読み比べてから、次の植物のページへ進む。';
const ADDED = '初めて読む人は guide.md の見本一覧を開き、葉の図と花の説明を順番に確かめる。';
const at = PARAGRAPH.indexOf('見本の説明');
const CHANGED = PARAGRAPH.slice(0, at) + ADDED + PARAGRAPH.slice(at);
const SETUP = ['# 架空の図鑑の読み方', '', '合成の見本で図と説明の対応を練習するときに読む。', '',
  '## 手順', '', '1. guide.md から架空の植物を選ぶ。', '2. 葉と花の見本番号を読み比べる。',
  '3. 説明に合う図を探す。', '',
  '| 場面 | 読む人 | 確かめること |', '|---|---|---|',
  '| 最初の見本の読み比べ | 初めて図鑑を読む人と、その場で架空の見本の番号を案内する人 | 葉と花に付けた番号、説明の段落、架空の季節、見本ごとの色と形、図を読む順番 |',
  '| 次の見本との比較 | 別の植物と比べたい人と、見本の説明を読み上げる人 | 色と形の違い、説明の長さ、図の並び方、葉と花を読む順番、見本番号の確かめ方 |'];
// A removed heading and sentence, an unrelated paragraph, a changed sentence and a new heading.
const UNRELATED = '見本の説明を読む前に、guide.md で架空の植物の図を眺める。';
const SKILLS_BEFORE = ['## 図の種類', '葉の図は、色と形が分かるように見本ごとに並べる。説明が無ければ番号から図を探す。'];
const SKILLS_AFTER = [UNRELATED, '', '葉の図は、色と形が分かるように見本ごとに並べる。説明が無ければ番号から図を探し、無い図は飛ばす。',
  '', '## 見本ごとに図を読む'];
const CODE_BEFORE = ['export function attach(report: string): string {', '  return report;', '}'];
const CODE_AFTER = ['export function attach(report: string, diffs: readonly string[]): string {',
  '  return [report, ...diffs.map(path => `![diff](${path})`)].join("\\n");', '}'];
const modified = (path: string, before: string[], after: string[]) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n` +
  `@@ -1,${before.length + 1} +1,${after.length + 1} @@\n # 見出し\n${before.map(line => '-' + line).join('\n')}\n${after.map(line => '+' + line).join('\n')}\n`;
const created = (path: string, lines: string[]) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n` +
  `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n`;
const source = (head: string) => ({ command: `git -C /work/repo diff 333333333..${head}`, repo: '/work/repo',
  base: { sha: '3'.repeat(40), written: '333333333' }, head: { sha: '7'.repeat(40), written: head }, paths: [] });
const file = (path: string, change: ReportDiff['files'][number]['change'], added: number, deleted: number, kept = true) =>
  ({ path, oldPath: null, change, added, deleted, kept });
const ONE: ReportDiff = { source: source('sample/catalog-guide'), commits: { title: 'T9001: catalog notes go to guide.md', total: 3, list: [
  { sha: '9'.repeat(40), date: '2001-02-04T12:00:00+09:00', subject: 'guide.md: wording (T9001 review 1)' },
  { sha: '8'.repeat(40), date: '2001-02-04T11:00:00+09:00', subject: 'Point catalog.md at guide.md' },
  { sha: '7'.repeat(40), date: '2001-02-03T10:00:00+09:00', subject: 'T9001: catalog notes go to guide.md' }] }, files: [
  file('catalog/plants/catalog.md', 'modified', 1, 1), file('catalog/plants/guide.md', 'added', SETUP.length, 0),
  file('docs/catalog.md', 'modified', SKILLS_AFTER.length, SKILLS_BEFORE.length)],
  patch: modified('catalog/plants/catalog.md', [PARAGRAPH], [CHANGED]) + created('catalog/plants/guide.md', SETUP) +
    modified('docs/catalog.md', SKILLS_BEFORE, SKILLS_AFTER) };
// Written before diffs named their commits: led by how much it changes.
const TWO: ReportDiff = { source: source('sample/catalog-labels'), commits: null, files: [
  file('catalog/labels/catalog.md', 'modified', 2, 0), file('catalog/labels/guide.md', 'added', 35, 0, false),
  file('apps/sample/src/attach.ts', 'modified', 2, 2)],
  patch: `diff --git a/catalog/labels/catalog.md b/catalog/labels/catalog.md\n--- a/catalog/labels/catalog.md\n` +
    `+++ b/catalog/labels/catalog.md\n@@ -1,1 +1,3 @@\n # 見出し\n+\n+最初の見本は guide.md から読む。\n` +
    modified('apps/sample/src/attach.ts', CODE_BEFORE.slice(0, 2), CODE_AFTER.slice(0, 2)) };
const DESCRIPTION = '見本の案内を2つ作り、図鑑から参照しました。\n\n```\ngit -C /work/repo diff 333333333...sample/catalog-guide\n' +
  'git -C /work/repo diff 333333333...sample/catalog-labels\n```\n\n![diff](diffs/1111111111111111.diff)\n![diff](diffs/2222222222222222.diff)\n\n独立点検は両方合格しています。';

test('a report shows its diffs as a summary; opened, a diff is read over the screen, a file at a time under its name', async ({ page, runtime }) => {
  test.setTimeout(90_000);
  const folder = join(taskFolder(runtime.root, 'T112'), 'diffs');
  mkdirSync(folder);
  const merged = (diff: ReportDiff) => ({ ...diff, source: { ...diff.source, command: diff.source.command.replace('..', '...') } });
  writeFileSync(join(folder, '1111111111111111.diff'), formatReportDiff(merged(ONE)));
  writeFileSync(join(folder, '2222222222222222.diff'), formatReportDiff(merged(TWO)));
  publishFixtureFiles(runtime.root);
  await expect.poll(async () => {
    const view = await (await fetch(`${runtime.origin}/api/task/view?task=T112`)).json() as { task: { files: { name: string }[] } };
    return view.task.files.filter(file => file.name.startsWith('diffs/')).length;
  }).toBe(2);
  seedReview(runtime.root, 'T112', { title: '架空の図鑑の差分を提出しました', description: DESCRIPTION });
  const asked: string[] = [];
  page.on('request', request => { if (request.url().includes('diffs%2F')) asked.push(new URL(request.url()).searchParams.get('part') ?? 'whole'); });
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, runtime, '?agent=1&task=T112');
  const reader = page.locator('aside[data-reader-mode]:visible');
  const row = reader.locator('[data-report-feed] li[data-report-key]').filter({ hasText: '架空の図鑑の差分を提出しました' });
  const summary = row.locator('[data-diff-summary]');
  // Each diff under its own heading, named by its commits' title (one written before diffs named their commits, by how
  // much it changes), never by its versions; the command block is the summary; the report goes on under it.
  await expect(summary.locator('[data-diff-title]')).toHaveText(['catalog notes go to guide.md']);
  await expect(summary.locator('[data-diff-commit-count]')).toHaveText(['コミット 3件']);
  await expect(summary.locator('[data-diff-counts]')).toHaveText([/^3ファイル \+\d+ −\d+$/, /^3ファイル \+\d+ −\d+$/]);
  await expect(summary).not.toContainText(/333333333|sample\/catalog-guide|sample\/catalog-labels/);
  await expect(row.locator('[data-code-block]')).toHaveCount(0);
  const [box, next] = [await summary.boundingBox(), await row.getByText('独立点検は両方合格しています。').boundingBox()];
  expect(next!.y - (box!.y + box!.height)).toBeLessThan(40);
  expect(asked).toEqual(['head', 'head']);
  // Opened: the diff it names read now, over the whole screen; a small one with every file open, read in place.
  await summary.locator('[data-diff-open]').first().click();
  const viewer = page.locator('[data-diff-viewer]');
  const heads = viewer.locator('[data-page-toggle]');
  await expect(heads).toHaveCount(3);
  expect(asked).toEqual(['head', 'head', 'whole']);
  // Its head is its title; its commits, newest first, open from their count.
  await expect(viewer.locator('[data-viewer-head] [data-diff-title]')).toHaveText('catalog notes go to guide.md');
  await viewer.locator('[data-diff-commits-toggle]').click();
  await expect(viewer.locator('[data-diff-commits] li')).toHaveText([/^guide\.md: wording \(review 1\)/, /^Point catalog\.md at guide\.md/, /^catalog notes go to guide\.md/]);
  await viewer.locator('[data-diff-commits-toggle]').click();
  await settleMotion(page);
  expect(await viewer.evaluate(element => { const b = element.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; })).toEqual([0, 0, 390, 844]);
  expect(await heads.evaluateAll(all => all.map(head => head.getAttribute('aria-expanded')))).toEqual(['true', 'true', 'true']);
  const skill = viewer.locator('[data-page="catalog/plants/catalog.md"]');
  await expect(skill.locator('[data-diff-prose] ins')).toHaveText([ADDED]);
  // A file closes and opens again from its heading.
  await skill.locator('[data-page-toggle]').click();
  await expect(skill.locator('[data-page-toggle]')).toHaveAttribute('aria-expanded', 'false');
  await expect(skill.locator('[data-page-body]')).toHaveCount(0);
  await skill.locator('[data-page-toggle]').click();
  await expect(skill.locator('[data-diff-prose] ins')).toHaveText([ADDED]);
  // The diff is in the URL: a reload opens it again; Back closes it to the report it was opened from.
  const url = () => new URL(page.url()).searchParams;
  expect(url().get('view')).toBe('T112/diffs/1111111111111111.diff');
  await page.reload();
  await expect(heads.first()).toBeVisible();
  await page.goBack();
  await expect(viewer).toHaveCount(0);
  expect([url().get('task'), url().has('view')]).toEqual(['T112', false]);
  await expect(summary).toBeVisible();
  // The other branch's diff: code by its numbered rows, the changed words alone marked, its heading on top while it is read.
  // Inspect the first DOM frame, before the worker can return colours: text must already be readable.
  const firstVisibility = page.evaluate(() => new Promise<string>(resolve => {
    const observer = new MutationObserver(() => {
      const rows = document.querySelector('[data-diff-viewer] [data-line-rows]');
      if (rows) { observer.disconnect(); resolve(getComputedStyle(rows).visibility); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }));
  await summary.locator('[data-diff-open]').nth(1).click();
  expect(await firstVisibility).toBe("visible");
  const code = viewer.locator('[data-page="apps/sample/src/attach.ts"]');
  const added = code.locator('[data-line-rows] [data-line="add"]');
  await expect(added.first()).toContainText('export function attach(report: string, diffs: readonly string[]): string {');
  await expect(added.first().locator('.bg-diff-add-word')).toHaveText([', diffs: readonly string[]']);
  // Read partway, its heading stays at the top of what scrolls.
  await page.setViewportSize({ width: 390, height: 320 });
  const scroller = viewer.locator('[data-viewer-body]');
  await scroller.evaluate((frame, at) => { const page = frame.querySelector<HTMLElement>(`[data-page="${at}"]`)!;
    frame.scrollTop += page.getBoundingClientRect().top - frame.getBoundingClientRect().top + 40; }, 'apps/sample/src/attach.ts');
  expect(await scroller.evaluate((frame, at) => Math.round(frame.querySelector(`[data-page="${at}"] [data-page-head]`)!.getBoundingClientRect().top
    - frame.getBoundingClientRect().top), 'apps/sample/src/attach.ts')).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  expect(url().get('task')).toBe('T112');
  // On a computer, side by side, a new document stands on its new side with its old one filled; the diff runs to
  // the screen's foot right of the reader, which has moved to the screen's left, and the coordinator stays left of it.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await summary.locator('[data-diff-open]').first().click();
  await expect(viewer).toHaveAttribute('data-viewer-place', 'page');
  await settleMotion(page);
  // Unchosen, it is side by side by its frame's width, one answer for the whole diff: its documents read by their
  // lines stay side by side as they were read by their words (this frame is wide enough for documents, not for code).
  const frame = await viewer.locator('[data-viewer-body]').evaluate(element => (element as HTMLElement).offsetWidth);
  expect(frame).toBeGreaterThanOrEqual(880);
  expect(frame).toBeLessThan(1100);
  const sides = viewer.getByRole('group', { name: '差分の並べ方' }).getByRole('button', { name: '左右' });
  await expect(sides).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('[data-diff-prose="split"]').first()).toBeVisible();
  await viewer.getByRole('button', { name: '元の文' }).click();
  await expect(sides).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('[data-side-rows]').first()).toBeVisible();
  await viewer.getByRole('button', { name: '整形' }).click();
  const [readerBox, viewerBox] = [await reader.boundingBox(), await viewer.boundingBox()];
  expect(readerBox!.x).toBeLessThan(viewerBox!.x);
  expect(readerBox!.x + readerBox!.width).toBeLessThanOrEqual(viewerBox!.x);
  // A heading pressed opens or closes its page where it stands: what is read is not scrolled to it.
  const setupHead = viewer.locator('[data-page="catalog/plants/guide.md"] [data-page-toggle]');
  const where = () => Promise.all([viewer.locator('[data-viewer-scroll]').evaluate(frame => frame.scrollTop),
    setupHead.evaluate(head => Math.round(head.getBoundingClientRect().top))]);
  const before = await where();
  await setupHead.click();
  await expect(setupHead).toHaveAttribute('aria-expanded', 'false');
  await setupHead.click();
  await expect(setupHead).toHaveAttribute('aria-expanded', 'true');
  await settleMotion(page);
  expect(await where()).toEqual(before);
  const setup = viewer.locator('[data-page="catalog/plants/guide.md"] [data-diff-prose="split"]');
  await expect(setup.locator(':scope > *').first()).toHaveAttribute('data-diff-empty', '');
  await expect(setup.locator(':scope > *').nth(1)).toContainText('架空の図鑑の読み方');
  const rect = async (selector: string) => page.locator(selector).first().evaluate(element => { const b = element.getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; });
  expect((await rect('[data-diff-viewer]')).bottom).toBe((await rect('aside[data-reader-mode]:visible')).bottom);
  // What stands over the foot (the coordinator's input, the task's actions over it) stands left of the diff, over the reader.
  const coordinator = await page.evaluate(() => Math.max(...[...document.querySelectorAll('[data-coordinator-card] [data-composer-frame], [data-coordinator-fold-row] > *')]
    .map(element => element.getBoundingClientRect()).filter(box => box.height > 0).map(box => box.right)));
  expect(coordinator).toBeGreaterThan(readerBox!.x);
  expect(coordinator).toBeLessThanOrEqual(viewerBox!.x);
  // One above the other, a document stands in the middle of its page at the reader's column, and a table wider than the
  // column reaches on to the page's right edge from the words' left.
  await viewer.getByRole('button', { name: '上下' }).click();
  const setupBody = viewer.locator('[data-page="catalog/plants/guide.md"] [data-page-body]');
  const edges = (locator: typeof setupBody) => locator.evaluate(element => { const b = element.getBoundingClientRect(); return { left: b.left, right: b.right }; });
  const [body, column, table] = [await edges(setupBody), await edges(setupBody.locator('[data-diff-column]')), await edges(setupBody.locator('[data-table-frame]'))];
  expect(Math.abs((column.left - body.left) - (body.right - column.right))).toBeLessThanOrEqual(1);
  expect(column.right - column.left).toBe(768);
  expect(table.right).toBeGreaterThan(column.right + 40);
  expect(table.right).toBeLessThanOrEqual(body.right - 16);
  await viewer.getByRole('button', { name: '左右' }).click();
  await page.keyboard.press('Escape');
  // A document that only adds a paragraph stands it on the new side too, its old side filled.
  await summary.locator('[data-diff-open]').nth(1).click();
  const onlyAdded = viewer.locator('[data-page="catalog/labels/catalog.md"] [data-diff-prose="split"] > *');
  await expect(onlyAdded.first()).toHaveAttribute('data-diff-empty', '');
  await expect(onlyAdded.nth(1)).toContainText('最初の見本は guide.md から読む。');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  // A path in the project's code location, written in a report, opens in the same viewer as a file; Back closes it.
  // Beside the workspace, not in it: alpacawork's data is never read as code.
  const place = mkdtempSync(join(tmpdir(), 'alpacawork-e2e-code-'));

  mkdirSync(join(place, 'src'), { recursive: true });
  writeFileSync(join(place, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  const config = parse(readFileSync(join(runtime.root, 'config.yaml'), 'utf8')) ?? {};
  writeFixtureConfig(runtime.root, stringify({ ...config, projects: { ...config.projects, [SAMPLE_PROJECT.id]: { cwd: place } } }, { lineWidth: 0 }));
  seedReview(runtime.root, 'T112', { title: '読むファイルを挙げました', description: `読むのは ${join(place, 'src', 'a.ts')} です。` });
  await open(page, runtime, '?agent=1&task=T112');
  const named = reader.locator('[data-report-feed] li[data-report-key]').filter({ hasText: '読むファイルを挙げました' });
  await named.locator(`[data-code-path="${join(place, 'src', 'a.ts')}"]`).click();
  const file = page.locator('[data-viewer="file"]');
  await expect(file.locator('[data-line-id]')).toHaveText(['1export const a = 1;', '2export const b = 2;']);
  await page.goBack();
  await expect(file).toHaveCount(0);
  expect(url().get('task')).toBe('T112');
  rmSync(place, { recursive: true, force: true });
});

test.describe('on a phone', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  /** A finger takes a phone's diff down as it takes a phone's sheet down; read partway, it scrolls back instead. */
  test('a diff on a phone is read up and down by a finger, and swiped down from its top it closes', async ({ page, runtime }) => {
    const folder = join(taskFolder(runtime.root, 'T112'), 'diffs');
    mkdirSync(folder);
    writeFileSync(join(folder, '1111111111111111.diff'), formatReportDiff(ONE));
    publishFixtureFiles(runtime.root);
    seedReview(runtime.root, 'T112', { title: '差分を出しました', description: '![diff](diffs/1111111111111111.diff)' });
    await open(page, runtime, '?agent=1&task=T112');
    await page.locator('aside[data-reader-mode]:visible [data-diff-open]').first().tap();
    const viewer = page.locator('[data-diff-viewer]');
    const scroller = viewer.locator('[data-viewer-body]');
    await expect(viewer.locator('[data-page-toggle]')).toHaveCount(3);
    await settleMotion(page);
    // Read partway, a finger going down scrolls back up what was read; the diff stays.
    await scroller.evaluate(frame => { frame.scrollTop = 200; });
    await swipe(page, { x: 200, y: 400 }, { x: 200, y: 600 });
    await expect.poll(() => scroller.evaluate(frame => frame.scrollTop)).toBe(0);
    await expect(viewer).toHaveCount(1);
    // Taken back by a second finger, it stands whole again, as tall as the screen as that changes.
    await touch(page, [[{ x: 200, y: 400 }], [{ x: 200, y: 460 }], [{ x: 200, y: 540 }], [{ x: 200, y: 540 }, { x: 100, y: 600 }]]);
    await settleMotion(page);
    await page.setViewportSize({ width: 390, height: 600 });
    await expect.poll(() => viewer.evaluate(element => element.getBoundingClientRect().bottom)).toBe(600);
    await page.setViewportSize({ width: 390, height: 844 });
    // From its top, the same finger takes it down and it closes, back to the report it was opened over. What goes down
    // is its still picture, a table's cells keeping their floor (data-fit), so the table does not fold anew as it goes.
    await page.evaluate(() => { const seen = window as unknown as { cells?: number }; new MutationObserver(records => { for (const record of records)
      for (const node of record.addedNodes) if (node instanceof Element && node.matches('[data-still-copy]')) seen.cells = node.querySelectorAll('td[data-fit]').length; })
      .observe(document.body, { childList: true }); });
    await swipe(page, { x: 200, y: 400 }, { x: 200, y: 700 });
    await expect(viewer).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { cells?: number }).cells)).toBeGreaterThan(0);
    expect(new URL(page.url()).searchParams.has('view')).toBe(false);
  });
});

/** One real submission path; the seeded case above guards the summary and viewer. */
test('CLI submits a frozen diff and a placed patch to the server; the report still reads after the branch is gone', async ({ page, runtime }) => {
  const repo = join(runtime.root, 'diff-input-repo'), home = join(runtime.root, 'diff-cli-home');
  mkdirSync(repo); mkdirSync(home);
  const env = cleanCliEnv({ HOME: home, XDG_STATE_HOME: join(home, 'state'), COREPACK_ENABLE_NETWORK: '0',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git('init', '-q', '-b', 'base');
  writeFileSync(join(repo, 'catalog.md'), '# 見出し\n' + PARAGRAPH + '\n');
  git('add', '.');
  const commit = () => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Synthetic change', '--no-gpg-sign');
  commit(); const base = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'submitted');
  writeFileSync(join(repo, 'catalog.md'), '# 見出し\n' + CHANGED + '\n');
  writeFileSync(join(repo, 'guide.md'), SETUP.join('\n') + '\n');
  git('add', '.'); commit();
  const head = git('rev-parse', 'HEAD'), command = `git -C ${repo} diff ${base}..submitted`;
  const patch = join(home, 'changes.patch');
  writeFileSync(patch, git('format-patch', '-1', '--stdout', '--no-signature') + '\n');
  const cli = (...args: string[]) => cliSync(runtime.origin, args, env);
  const get = () => {
    const result = cli('task', 'get', '--task', 'T112', '--log', '20', '--include', 'files');
    expect(result.code, result.stderr).toBe(0);
    return JSON.parse(result.stdout).task as { hash: string; log: { title: string; description: string }[]; files: { name: string }[] };
  };
  const description = join(home, 'description.md');
  const submit = (text: string, title: string, verb: 'report' | 'comment' = 'comment') => {
    writeFileSync(description, text);
    return cli('task', verb, '--task', 'T112', ...(verb === 'report' ? ['--state', 'held'] : []),
      '--title', title, '--description-file', description, '--expected-task-hash', get().hash);
  };
  // A failed explicit comparison must leave neither an upload nor a report.
  const before = get();
  const refused = submit(`\`${command}\`\n\`git -C ${repo} diff ${base}..missing\``, 'Missing revision', 'report');
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain('missing');
  expect(get()).toEqual(before);
  const sent = submit(`段落に導入の説明を足しました。\n\n\`\`\`sh\n${command}\n\`\`\``, 'CLIから差分を提出しました', 'report');
  expect(sent.code, sent.stderr).toBe(0);
  const summary = JSON.parse(sent.stdout).diffs[0] as { path: string; files: number };
  const bytes = readFileSync(join(taskFolder(runtime.root, 'T112'), summary.path));
  expect(summary.path).toBe(`diffs/${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.diff`);
  expect(summary.files).toBe(2);
  const snapshot = parseReportDiff(bytes.toString());
  expect(snapshot?.source.base.sha).toBe(base); expect(snapshot?.source.head.sha).toBe(head);
  expect(snapshot?.commits).toEqual({ title: 'Synthetic change', total: 1, list: [expect.objectContaining({ sha: head, subject: 'Synthetic change' })] });
  expect(get().log.find(row => row.title === 'CLIから差分を提出しました')?.description).toContain(`![diff](${summary.path})`);
  const stored = await fetch(`${runtime.origin}/api/tasks/T112/file?path=${encodeURIComponent(summary.path)}`);
  expect(stored.status).toBe(200); expect(Buffer.from(await stored.arrayBuffer())).toEqual(bytes);
  git('switch', '-q', 'base'); git('branch', '-D', 'submitted');
  rmSync(repo, { recursive: true }); // Reading must depend on the saved bytes alone.
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, runtime, '?agent=1&task=T112');
  // A person's hold is a change row: open its report body before reading the attachment.
  const row = page.locator('[data-report-feed] li[data-report-key]').filter({ hasText: '保留にしました' });
  await row.getByRole('button', { name: /保留にしました/ }).click();
  // The saved diff reads with its branch gone: its summary from the saved header; in the Files tab, named by its commit's title.
  await expect(row.locator('[data-diff-summary] [data-diff-title]')).toHaveText('Synthetic change');
  await open(page, runtime, '?agent=1&task=T112&tab=files');
  await expect(page.locator('aside[data-reader-mode]:visible [data-diff-title]')).toHaveText('Synthetic change');
  // Ordinary Task files use the same validation/rendering registry as captured diffs.
  const uploaded = cli('task', 'file', 'put', '--task', 'T112', '--path', 'changes.patch', '--file', patch);
  expect(uploaded.code, uploaded.stderr).toBe(0);
  const placed = submit('![差分](changes.patch)', '置いたパッチを提出しました');
  expect(placed.code, placed.stderr).toBe(0);
  const unsupportedText = '\`git diff --cached\`';
  const unsupported = submit(unsupportedText, '作業中の差分');
  expect(unsupported.code, unsupported.stderr).toBe(0);
  expect(JSON.parse(unsupported.stdout).diffs[0].attached).toBe(false);
  expect(JSON.parse(unsupported.stdout).diffs[0].reason).toBeTruthy();
  expect(get().log.find(row => row.title === '作業中の差分')?.description).toBe(unsupportedText);
  await open(page, runtime, '?agent=1&task=T112');
  const placedRow = page.locator('[data-report-feed] li[data-report-key]').filter({ hasText: '置いたパッチを提出しました' });
  // Comments are initially folded, unlike the state report.
  await placedRow.click();
  await expect(placedRow.locator('[data-diff-summary] [data-diff-open]')).toBeVisible();
});
