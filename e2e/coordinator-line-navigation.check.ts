
import { test as base, expect, open, openCoordinator, writeCoordinator } from './fixtures.ts';
import { configureCoordinator } from './coordinator-fixture.ts';
import { start } from './server.ts';
import type { Locator, Page } from '@playwright/test';

const test = base.extend({ runtime: async ({}, use) => {
  const runtime = await start(undefined, configureCoordinator);
  try { await use(runtime); } finally { await runtime.stop(); }
} });
test.use({ isolated: true, channel: 'chrome', viewport: { width: 1440, height: 900 } });
const field = (page: Page) => page.locator('[data-one-input]');
const selection = (field: Locator) => field.evaluate(element => {
  const editor = (element as any).editor, native = element.ownerDocument.getSelection();
  return { from: editor.state.selection.from, to: editor.state.selection.to,
    text: native?.focusNode?.textContent, offset: native?.focusOffset, collapsed: native?.isCollapsed,
    nativePos: native?.focusNode && element.contains(native.focusNode) ? editor.view.posAtDOM(native.focusNode, native.focusOffset) : null };
});
async function begin(page: Page, origin: { origin: string; root: string }) {
  await open(page, origin, '?agent=1'); await writeCoordinator(page); await openCoordinator(page);
  await expect(field(page)).toHaveAttribute('contenteditable', 'true');
}
async function seed(input: Locator, content: unknown[], pos?: number) {
  await input.evaluate((element, { content, pos }) => {
    const editor = (element as any).editor;
    editor.chain().setContent({ type: 'doc', content }).setMeta('addToHistory', false).run();
    editor.commands.setTextSelection(pos ?? editor.state.doc.content.size - 1);
    editor.view.focus();
    // A press or a native move leaves the caret inside the text beside it, not between the paragraph's children.
    const { node, offset } = editor.view.domAtPos(editor.state.selection.head), after = node.childNodes[offset];
    if (after?.nodeType === Node.TEXT_NODE) element.ownerDocument.getSelection()!.collapse(after, 0);
  }, { content, pos });
  await input.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
const text = (text: string) => ({ type: 'text', text });
const br = { type: 'hardBreak' };
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', content });
const task = { type: 'taskLabel', attrs: { id: 'T112', title: 'Tasks' } };


test.describe('native vertical line navigation', () => {
  test.use({ fixedTime: false });
  for (const scenario of [
    { name: 'hard breaks', content: [paragraph(text('First'), br, text('Second'), br, text('Third'))], positions: [14, 7, 1, 7, 14] },
    // A label alone on the first line, then an empty line: up from the text stops on the empty line first.
    { name: 'a label line and an empty line', content: [paragraph(task, br, br, text('Third'))], positions: [4, 3, 1, 3, 4] },
  ]) test(`up and down traverse ${scenario.name} one line at a time`, async ({ page, runtime }, info) => {
    await begin(page, runtime);
    const input = field(page), positions = scenario.positions;
    await seed(input, scenario.content, positions[0]);
    // PM protects against a browser focus reset to document start for 200ms. Exercise ongoing editing.
    await page.waitForTimeout(250);
    const traces: unknown[] = [];
    for (const [index, key] of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown'].entries()) {
      const from = positions[index]!, to = positions[index + 1]!;
      // Capture native positions before PM's selection observer can normalize them, plus each paint for 100ms.
      await input.evaluate(element => {
        const editor = (element as any).editor, samples: number[] = [];
        const sample = () => {
          const native = element.ownerDocument.getSelection();
          if (native?.focusNode && element.contains(native.focusNode)) samples.push(editor.view.posAtDOM(native.focusNode, native.focusOffset));
        };
        const changed = () => sample();
        element.ownerDocument.addEventListener('selectionchange', changed, true);
        (element as any).verticalTrace = new Promise<number[]>(resolve => {
          element.addEventListener('keydown', () => {
            const started = performance.now();
            const frame = () => {
              sample();
              if (performance.now() - started < 100) requestAnimationFrame(frame);
              else { element.ownerDocument.removeEventListener('selectionchange', changed, true); resolve(samples); }
            };
            requestAnimationFrame(frame);
          }, { once: true });
        });
      });
      await input.press(key);
      const samples: number[] = await input.evaluate(element => (element as any).verticalTrace);
      const settled = await selection(input);
      traces.push({ key, from, to, samples, settled });
      await info.attach(`${index}-${key}`, { body: JSON.stringify(traces, null, 2), contentType: 'application/json' });
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.every(pos => pos === from || pos === to), 'no transient jump to another line').toBe(true);
      expect(settled).toMatchObject({ from: to, to, nativePos: to, collapsed: true });
    }
    // Selection expansion still belongs to the browser, and typing edits that selected line.
    await input.press('Shift+ArrowUp');
    expect((await selection(input)).collapsed).toBe(false);
    await page.keyboard.insertText('Edited');
    await expect(input).toContainText('Edited');
    await expect(page.locator('[data-coordinator-turn]')).toHaveCount(0);
  });
});
