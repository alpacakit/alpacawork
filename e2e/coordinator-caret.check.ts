import { labelLayer } from './editor-surface.ts';
import { test, expect, open } from './fixtures.ts';
import { configureCoordinator } from './coordinator-fixture.ts';
import { devices, type Locator, type Page } from '@playwright/test';

const task = (id = 'T112') => ({ type: 'taskLabel', attrs: { id, title: 'Tasks' } });
const text = (value: string) => ({ type: 'text', text: value });
const paragraph = (...content: unknown[]) => ({ type: 'paragraph', ...(content.length ? { content } : {}) });
// Seed a document, then exercise native hit testing and editing through actual mouse/touch input.
async function seed(field: Locator, content: unknown[]) {
  await field.evaluate((element, content) => {
    const editor = (element as any).editor;
    editor.commands.setContent({ type: 'doc', content });
    editor.commands.setTextSelection(1);
    (element as HTMLElement).blur();
  }, content);
  await field.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  // Independent taps must not turn into a browser double/triple tap across seeded scenarios.
  await field.page().waitForTimeout(350);
}
const json = (field: Locator) => field.evaluate(element => (element as any).editor.getJSON());
const selection = (field: Locator) => field.evaluate(element => {
  const { from, to } = (element as any).editor.state.selection; return { from, to };
});
async function waitForInitialTaskSeed(field: Locator) {
  await expect.poll(async () => (await json(field)).content.flatMap((block: any) => block.content ?? [])
    .filter((node: any) => node.type === 'taskLabel').map((node: any) => node.attrs.id)).toEqual(['T112']);
}

async function pressAt(page: Page, phone: boolean, x: number, y: number) {
  if (phone) await page.touchscreen.tap(x, y); else await page.mouse.click(x, y);
  // Native selectionchange is delivered after the pointer event, including touch's synthesized click.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

for (const phone of [false]) test.describe(phone ? 'touch' : 'mouse', () => {
  test.use({ ...(phone ? { userAgent: devices['Pixel 7'].userAgent } : {}), isolated: true, viewport: phone ? { width: 360, height: 844 } : { width: 1440, height: 900 }, hasTouch: phone, isMobile: phone });
  test('blank taps append after labels and keep native text editing, selection and composition', async ({ page, runtime }) => {
    configureCoordinator(runtime.root);
    await open(page, runtime, '?agent=1&task=T112');
    // The input is folded to one line at the foot until it is pressed.
    const line = page.locator('[data-coordinator-write]'); if (phone) await line.tap(); else await line.click();
    const field = page.locator('[data-one-input]'); await expect(field).toBeVisible();
    await waitForInitialTaskSeed(field);
    // Hint hit, far right, lower padding: each starts from a stale selection before the label.
    for (const content of [[], [task()], [task(), task('T111'), task('T114')]]) {
      for (const where of ['hint', 'right', 'bottom']) {
        await seed(field, [paragraph(...content)]);
        const box = (await field.boundingBox())!;
        const last = field.locator('[data-label-slot]').last();
        const label = content.length ? (await last.boundingBox())! : null;
        const x = where === 'hint' && label ? Math.min(label.x + label.width + 20, box.x + box.width - 12) : box.x + box.width - 12;
        const y = where === 'bottom' ? box.y + box.height - 2 : label ? label.y + label.height / 2 : box.y + 18;
        await pressAt(page, phone, x, y);
        await page.keyboard.insertText('Added');
        const result = await json(field);
        expect(result.content[0].content.map((node: any) => node.type), `${content.length} labels ${where}`).toEqual([...content.map(() => 'taskLabel'), 'text']);
        expect(result.content[0].content.at(-1).text).toBe('Added');
      }
    }
    // Multiple paragraphs, including trailing labels; blank space below the last line appends there.
    await seed(field, [paragraph(task(), text(' Previous text')), paragraph(task('T111'))]);
    let box = (await field.boundingBox())!;
    await pressAt(page, phone, box.x + box.width - 12, box.y + box.height - 2);
    await page.keyboard.insertText('End');
    expect((await json(field)).content[1].content.at(-1).text).toBe('End');
    // Text on each side of an atom: a character boundary must stay where it was pressed after refocus.
    for (const word of ['Before', 'After']) {
      await seed(field, [paragraph(text('Before'), task(), text('After'))]);
      const point = await field.evaluate((element, word) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) if (node.textContent === word) {
          const range = document.createRange(); range.setStart(node, 2); range.setEnd(node, 3);
          const rect = range.getBoundingClientRect(); return { x: rect.left + 0.5, y: rect.top + rect.height / 2 };
        }
        throw new Error('Text missing');
      }, word);
      await pressAt(page, phone, point.x, point.y);
      await expect.poll(async () => (await selection(field)).from).toBe(word.startsWith('Before') ? 3 : 10);
      await page.keyboard.insertText('X');
      await expect.poll(async () => (await json(field)).content[0].content.find((node: any) => node.text?.includes('X'))?.text).toBe(word.slice(0, 2) + 'X' + word.slice(2));
    }
    await seed(field, [paragraph(task(), text('Select'))]);
    box = (await field.boundingBox())!;
    await pressAt(page, phone, box.x + box.width - 12, box.y + 18);
    await expect.poll(async () => (await selection(field)).from).toBe(8);
    await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft');
    // Touch selection belongs to the browser; ProseMirror's cached selection may lag it.
    // Observe what is selected and what real typing replaces, rather than the cache's timing.
    await expect.poll(() => field.evaluate(element => element.ownerDocument.getSelection()?.toString())).toBe('ct');
    await page.keyboard.insertText('Replace');
    await expect.poll(async () => (await json(field)).content[0].content.at(-1).text).toBe('SeleReplace');
    await page.keyboard.press('ControlOrMeta+Home'); await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Backspace');
    await expect(labelLayer(field).locator('[data-label]')).toHaveCount(0);
    await expect(field.locator('[data-label-slot]')).toHaveCount(0);
    await page.keyboard.press('End'); await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('Line break');
    expect((await json(field)).content[0].content.some((node: any) => node.type === 'hardBreak')).toBe(true);
    // Synthetic composition verifies our event guards; it does not claim to drive an OS Japanese IME.
    await seed(field, [paragraph(task(), text('日本語の'))]);
    box = (await field.boundingBox())!;
    await pressAt(page, phone, box.x + box.width - 12, box.y + 18);
    await field.dispatchEvent('compositionstart', { data: '' });
    await field.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
    await page.keyboard.insertText('日本語');
    await field.dispatchEvent('compositionend', { data: '日本語' });
    await expect(field).toContainText('日本語の日本語');
    await expect(labelLayer(field).locator('[data-label]')).toHaveCount(1);
    await expect(field.locator('[data-label-slot=taskLabel]')).toHaveCount(1);
    await expect(page.locator('[data-coordinator-turn]')).toHaveCount(0);
  });
});
