/** How the report diff viewer moves on the real app, pressed as a person does: a report's diff opened from its
 * summary in the report (the diff over the screen), one file in it opened from its heading and closed again, and the diff
 * closed by its ×. At 1440×900 by a mouse and 390×900 by a finger (isMobile). The diff is moderately large (10 files, about
 * 600 rows), so it starts on its closed headings (a computer's first file open) and its cost is visible.
 * node --import ./e2e/guard-loader.mjs e2e/perf/diff-motion.ts <output.json> [--throttle 4] [--rounds 3] [--widths 1440,390] [--film] [--profile]
 * The fixture is report-diff.check.ts's: diffs/<hex>.diff in T112's folder, embedded as ![diff](…) in a seeded
 * review, on the isolated e2e serve. The instrument is motion-probe.ts. Every serve and browser is closed here, with an expiry.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Locator } from '@playwright/test';
import { formatReportDiff, type ReportDiff } from '@alpacawork/contract/report-diff';
import { start } from '../server.ts';
import { publishFixtureFiles } from '../fixture-writes.ts';
import { seedReview, taskFolder } from '../fixture/task-state.ts';
import { installProbe, measurer } from './motion-probe.ts';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  throttle: { type: 'string', default: '4' }, rounds: { type: 'string', default: '3' }, film: { type: 'boolean', default: false },
  profile: { type: 'boolean', default: false }, widths: { type: 'string', default: '1440,390' },
} });
const output = resolve(positionals[0] ?? '/tmp/diff-motion.json');
const throttle = Number(args.throttle), rounds = Number(args.rounds);
mkdirSync(dirname(output), { recursive: true });

// Code files with every third row changed, and new documents: 10 files, about 600 rows, over viewerLayout's open bound.
const codeLine = (file: number, row: number, changed = false) => row % 6 === 0
  ? `export function step${file}_${row}(input: readonly string[], limit = ${row}): string[] {`
  : `  const value${row} = input.slice(0, limit).map(each => each.trim()${changed ? `.toLowerCase().padEnd(${row % 17})` : ''});`;
const code = (path: string, file: number, rows: number) => {
  const body = Array.from({ length: rows }, (_, row) => row % 3 === 1 ? [`-${codeLine(file, row)}`, `+${codeLine(file, row, true)}`] : [` ${codeLine(file, row)}`]).flat();
  return { patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${rows} +1,${rows} @@\n${body.join('\n')}\n`, changed: Math.floor((rows + 1) / 3) };
};
const prose = (path: string, rows: number) => {
  const lines = Array.from({ length: rows }, (_, row) => row % 8 === 0 ? `## 節 ${row / 8 + 1}` : row % 8 === 7 ? ''
    : `- 手順 ${row}: 架空の葉の図を選び、花の形を読み比べ、見本の色を確かめる。結果は見本の記録に書く。`);
  return { patch: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${rows} @@\n${lines.map(line => '+' + line).join('\n')}\n`, rows };
};
const codePaths = ['apps/cli/src/report.ts', 'apps/cli/src/diff.ts', 'apps/backend/src/files.ts', 'apps/backend/src/serve.ts',
  'apps/web/src/viewer/pages.ts', 'apps/web/src/viewer/rows.ts', 'packages/contract/src/report-diff.ts'];
const docPaths = ['docs/setup.md', 'docs/skills.md', 'skills/alpacawork/setup.md'];
const files: ReportDiff['files'] = []; let patch = '';
codePaths.forEach((path, i) => { const one = code(path, i, 60); files.push({ path, oldPath: null, change: 'modified', added: one.changed, deleted: one.changed, kept: true }); patch += one.patch; });
docPaths.forEach(path => { const one = prose(path, 40); files.push({ path, oldPath: null, change: 'added', added: one.rows, deleted: 0, kept: true }); patch += one.patch; });
const DIFF: ReportDiff = { source: { command: 'git -C /work/repo diff 333333333...sample/diff-motion', repo: '/work/repo',
  base: { sha: '3'.repeat(40), written: '333333333' }, head: { sha: '7'.repeat(40), written: 'sample/diff-motion' }, paths: [] },
  commits: { title: 'Synthetic diff viewer sample', total: 2, list: [
    { sha: '9'.repeat(40), date: '2001-02-04T12:00:00+09:00', subject: 'Viewer pages: wording' },
    { sha: '7'.repeat(40), date: '2001-02-03T10:00:00+09:00', subject: 'Synthetic diff viewer sample' }] }, files, patch };
const TITLE = '差分の計測用の報告です';
// The file opened and closed in each round: closed at the start on both widths (a computer opens only the first).
const FILE = 'apps/backend/src/serve.ts';

const results: unknown[] = [];
const runtime = await start();
const browser = await chromium.launch().catch(async error => { await runtime.stop(); throw error; });
const expiry = setTimeout(() => { console.error('expired'); process.exit(3); }, 15 * 60_000);
try {
  const folder = join(taskFolder(runtime.root, 'T112'), 'diffs');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '7757757757757757.diff'), formatReportDiff(DIFF));
  publishFixtureFiles(runtime.root);
  seedReview(runtime.root, 'T112', { title: TITLE, description: `計測用の差分を添えました。\n\n![diff](diffs/7757757757757757.diff)\n\n以上です。` });
  for (const width of args.widths.split(',').map(Number)) {
    const touch = width < 700;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true, isMobile: touch,
      locale: 'ja-JP', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => console.error('pageerror', error.message));
    await installProbe(page);
    const measure = await measurer(page, context, { output, width, throttle, film: args.film, profile: args.profile }, results);
    // A finger taps, a mouse clicks; each waits for its target to stand still (Playwright's actionability), as a person does.
    const press = (target: Locator) => touch ? target.tap() : target.click();
    const run = async (name: string, span: number, work: () => Promise<unknown>, check: () => Promise<boolean>) => {
      const result = await measure(name, span, work);
      result.valid = await check();
      if (!result.valid) console.log(`${width} ${name}: check failed`);
      writeFileSync(output, JSON.stringify({ version: 1, browser: browser.version(), throttle, results }, null, 2));
    };
    const reader = page.locator('aside[data-reader-mode]:visible');
    const summary = reader.locator('[data-report-feed] li[data-report-key]').filter({ hasText: TITLE }).locator('[data-diff-summary]');
    const viewer = page.locator('[data-diff-viewer]');
    const heads = viewer.locator('[data-page-toggle]');
    const file = viewer.locator(`[data-page="${FILE}"]`);
    const fileHead = file.locator('[data-page-toggle]');
    await page.goto(`${runtime.origin}/?agent=1&task=T112`);
    await summary.locator('[data-diff-open]').waitFor();
    // Opened and closed once outside the windows: the first open loads the viewer's code and its painter.
    await press(summary.locator('[data-diff-open]'));
    await heads.first().waitFor();
    await page.waitForTimeout(800);
    await press(viewer.locator('[data-viewer-close]:visible').first());
    await viewer.waitFor({ state: 'detached' });
    for (let round = 0; round < rounds; round++) {
      await summary.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(400);
      await run(`diff-open-${round}`, 900, async () => { await press(summary.locator('[data-diff-open]')); await heads.first().waitFor(); },
        async () => await viewer.count() === 1 && await heads.count() === files.length && new URL(page.url()).searchParams.has('view'));
      await page.waitForTimeout(400);
      if (await fileHead.getAttribute('aria-expanded') !== 'false') throw Error(`${FILE} is open before it is pressed`);
      await fileHead.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(400);
      await run(`diff-file-open-${round}`, 750, () => press(fileHead),
        async () => await fileHead.getAttribute('aria-expanded') === 'true' && await file.locator('[data-page-body] [data-line="add"]').count() > 0);
      await run(`diff-file-close-${round}`, 750, () => press(fileHead),
        async () => await fileHead.getAttribute('aria-expanded') === 'false' && await file.locator('[data-page-body]').count() === 0);
      await run(`diff-close-${round}`, 900, () => press(viewer.locator('[data-viewer-close]:visible').first()),
        async () => await viewer.count() === 0 && !new URL(page.url()).searchParams.has('view') && await summary.isVisible());
    }
    await context.close();
  }
} finally { clearTimeout(expiry); await browser.close(); await runtime.stop(); }
