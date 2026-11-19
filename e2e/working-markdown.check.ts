import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { RunStore } from '@alpacawork/runs';
import { OutputActivityReader } from '@alpacawork/backend/test-dist/runs/activity.js';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { startServer } from './fixture/server.ts';
import { runningRunsTest } from './fixture/running-runs.ts';
import { expect } from './fixtures.ts';

const text = '調査をまとめました。`claude-fable-5-1` と **確認済み** の結果を [計画](plan.md) に記録しています。\n\n- [外の資料](/tmp/synthetic-notes.md) を確認\n- `code` とリンクを同じ描画にそろえます。\n\n' + '長い進捗も展開して読むことができます。'.repeat(10);
const shapes = {
  paragraphs: '調査を終えました。\n\n次に、計画のとおり変更を入れて確かめます。',
  list: '短い一行。\n\n- 項目1を確認します\n- 項目2を確認します',
  heading: '# 見出しから始まる文\n次に、変更を入れます。',
  code: '```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```',
};
const test = runningRunsTest.extend<{ shapes: { name: string; text: string; id: string }[] }>({
  shapes: async ({ scene }, use) => {
    const store = new RunStore(scene.root, { busyTimeoutMs: 1000 });
    const runs = store.read();
    const ids = [scene.busy, scene.asked, scene.crowded, runs.find(run => run.id === scene.grandchildRun)!.task!];
    const cases = Object.entries(shapes).map(([name, text], i) => ({ name, text, id: ids[i]! }));
    const owners = [{ id: scene.single, text }, ...cases].map(item => ({ run: runs.find(run => run.task === item.id && run.role === 'owner')!.id, text: item.text }));
    // busy's member has words too: a person with none draws no words, and its open row shows both people's.
    for (const item of [...owners, { run: scene.busyMember, text: '変更の確認を手伝っています。' }]) {
      const folder = store.folder(item.run);
      writeFileSync(join(folder, 'stdout.log'), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: item.text } }) + '\n');
      new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.codex).poll(folder);
    }
    store.close();
    mkdirSync(join(scene.root, 'tasks', scene.single), { recursive: true });
    writeFileSync(join(scene.root, 'tasks', scene.single, 'plan.md'), '# Synthetic plan\n');
    await use(cases);
  },
  runtime: async ({ scene, shapes: _shapes }, use) => {
    const app = await startServer(scene.root, 0);
    try { await use({ root: scene.root, origin: new URL(app.url).origin }); } finally { await app.close(); }
  },
});

// One real activity projection and reader flow at the two widths; prepare every shape before serve.
test('working words share Markdown, bounded display and file actions at PC and phone widths', async ({ page, runtime, scene, shapes }, info) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${runtime.origin}/?agent=1&task=${scene.single}`);
    const row = page.locator('[data-working-here]');
    const note = row.locator('[data-working-note]').first();
    await expect(note).toContainText('claude-fable-5-1');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    const shot = async (state: string) => {
      const path = info.outputPath(`${width}-${state}.png`);
      await page.screenshot({ path, animations: 'disabled' });
    };
    await shot('folded');
    await expect(note.locator('code').first()).toHaveText('claude-fable-5-1');
    await expect(note.locator('strong')).toHaveText('確認済み');
    await expect(note.getByRole('link', { name: '計画' })).toHaveAttribute('href', /plan.md/);
    const dimensions = await note.evaluate(element => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight) }));
    expect(dimensions.height).toBeLessThanOrEqual(dimensions.line * 2.5 + 1);
    await note.getByRole('link', { name: '計画' }).focus();
    await page.keyboard.press(' ');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await row.locator('[data-working-model]').first().click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await shot('open');
    await expect(note.locator('ul > li')).toHaveCount(2);
    await note.getByRole('button', { name: /synthetic-notes.md/ }).click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await note.getByRole('link', { name: '計画' }).click();
    await expect(page).toHaveURL(/view=T\d+%2Fplan\.md/);
    await page.goto(`${runtime.origin}/?agent=1&task=${scene.busy}`);
    await page.locator('[data-working-model]').first().click();
    await expect(page.locator('[data-working-note]')).toHaveCount(2);
    for (const words of await page.locator('[data-working-note]').all()) {
      const sizes = await words.evaluate(element => [getComputedStyle(element).fontSize, getComputedStyle(element.firstElementChild!).fontSize]);
      expect(sizes[1]).toBe(sizes[0]);
    }
    for (const { name, text, id } of shapes) {
      await page.goto(`${runtime.origin}/?agent=1&task=${id}`);
      await expect(row).toHaveAttribute('aria-expanded', 'false');
      await expect(note).toContainText(text.includes('```') ? 'const a' : text.split('\n')[0]!.replace(/^# /, ''));
      const geometry = await note.evaluate(element => {
        const box = element.getBoundingClientRect();
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const partial: string[] = [], visible: number[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.top < box.bottom - 1 && rect.bottom > box.top + 1 && rect.width) {
              if (rect.bottom > box.bottom + 1 || rect.top < box.top - 1) partial.push(node.textContent!);
              visible.push(rect.top);
            }
          }
        }
        return { height: box.height, line: parseFloat(getComputedStyle(element).lineHeight), partial, visible };
      });
      expect(geometry.partial, `${width}px ${name}: no partial letters`).toEqual([]);
      expect(geometry.visible.length).toBeGreaterThan(0);
      expect(geometry.height).toBeLessThanOrEqual(Math.ceil(geometry.line * 2.5 + 1));
      await page.screenshot({ path: info.outputPath(`${width}-${name}-folded.png`), animations: 'disabled' });
      await row.locator('[data-working-model]').first().click();
      await expect(row).toHaveAttribute('aria-expanded', 'true');
    }
  }
});
