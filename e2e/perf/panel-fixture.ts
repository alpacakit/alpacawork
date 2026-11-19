import { copyFileSync } from 'node:fs';
import { ControlStore } from '@alpacawork/db';
import type { CoordinatorConversation } from '../../apps/web/src/data/coordinator.ts';
import { start } from '../server.ts';
import { patchTask, taskFolder } from '../fixture/task-state.ts';
import { SAMPLE_NOW } from '../fixture/sample.ts';
import type { Page } from '@playwright/test';

export const conversation: CoordinatorConversation = { id: 'render-motion', agent: 'claude', warm: 'none' as const, busy: false, cancelled: [],
  turns: Array.from({ length: 12 }, (_, i) => ({ id: `turn-${i}`, at: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
    ask: `Measurement request ${i}`, attachments: [], status: 'succeeded', waiting: false, seen: true, error: null, result: null,
    answer: Array.from({ length: 25 }, (_, n) => `### Item ${n}\nText with explanations and **checks**. Compare load under the same conditions.\n\n- Result ${n}\n- Next review\n\n`).join(''),
    answeredAt: `2026-01-01T00:${String(i).padStart(2, '0')}:30Z` })) };
export const startPanelFixture = (heavy: boolean) => start(undefined, root => {
  const folder = taskFolder(root, 'T111');
  copyFileSync(new URL('../fixture/wide-report.png', import.meta.url), folder + '/screen.png');
  copyFileSync(new URL('../fixture/swipe-clip.webm', import.meta.url), folder + '/clip.webm');
  const db = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  const placement = (() => { try { return db.read(sql => String(sql.prepare("SELECT id FROM placements WHERE task_id='T111' AND responsible=1").get()!.id)); } finally { db.close(); } })();
  const text = Array.from({ length: heavy ? 35 : 3 }, (_, n) => '### Review ' + n + '\nA report with **results**, reading text and a table.\n\n| Item | Value |\n| --- | --- |\n| Check | Passed |\n\n').join('');
  const media = '\n![Report image](screen.png)\n![Report video](clip.webm)\n';
  const logs = Array.from({ length: heavy ? 120 : 6 }, (_, n) => ({
    id: 'resize-log-' + n, at: new Date(Date.parse(SAMPLE_NOW) - ((heavy ? 120 : 6) - n) * 60000).toISOString(),
    kind: 'reported', title: 'Performance report ' + n,
    description: text.split('### Review 3')[0] + (n === (heavy ? 119 : 5) ? media : ''),
    actor: { kind: 'placement', placementId: placement }, fromState: 'doing', toState: 'doing' }));
  patchTask(root, 'T111', { values: { notes: (text + media).trim() }, logs });
});

/** Open the real report body; the large fixture also opens the long Context page. */
export async function preparePanel(page: Page, heavy: boolean) {
  await page.locator('[data-reader-content] [data-report-feed]').waitFor();
  const newest = page.getByRole('button', { name: new RegExp('Performance report ' + (heavy ? 119 : 5) + '$') });
  if (await newest.getAttribute('aria-expanded') !== 'true') await newest.click();
  if (heavy) {
    await page.locator('[data-reader-entry="about"]').click();
    await page.locator('[data-task-about]').waitFor();
  }
  const scope = heavy ? page.locator('[data-task-about]') : page.locator('[data-reader-content]');
  await scope.locator('img').first().waitFor({ state: 'visible' });
  await scope.locator('video').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-reader-content] img')].some(img => img.complete && img.naturalWidth > 0));
  await scope.locator('video').first().evaluate(async (video: HTMLVideoElement) => { video.muted = true; video.loop = true; await video.play(); });
  await page.waitForTimeout(400);
  await scope.locator('video').first().evaluate(video => video.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
}

export const PANEL_DRAFT = 'Draft kept during resize';
export const readPanelDraft = (page: Page) => page.locator('[data-one-input]').evaluate(field => {
  type Node = { text?: string; content?: Node[] };
  const editor = (field as HTMLElement & { editor?: { getJSON: () => Node } }).editor;
  if (!editor) throw Error('The real rich-text editor is unavailable');
  // Task/answer labels are atoms, not typed words. Opening a task may legitimately add its automatic context label.
  const text = (node: Node): string => (node.text ?? '') + (node.content ?? []).map(text).join('');
  return text(editor.getJSON()).trim();
});
/** Outside taps normally fold the conversation; reopen it after preparing the report, without replacing the draft. */
export async function ensureConversation(page: Page, initialize = false) {
  if (!await page.locator('[data-coordinator-panel]').isVisible()) await page.locator('[data-coordinator-expand]').first().click();
  await page.locator('[data-coordinator-panel]').waitFor({ state: 'visible' });
  const input = page.locator('[data-one-input]');
  await input.waitFor();
  if (initialize) await input.fill(PANEL_DRAFT);
  else if (await readPanelDraft(page) !== PANEL_DRAFT) throw Error('The conversation draft was not retained');
  await page.waitForTimeout(350);
}
