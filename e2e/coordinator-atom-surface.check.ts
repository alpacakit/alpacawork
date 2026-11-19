import { test, expect, open, writeCoordinator, settleMotion } from './fixtures.ts';
import { configureCoordinator } from './coordinator-fixture.ts';

const text = (text: string) => ({ type: 'text', text });
const atoms = [
  { type: 'taskLabel', attrs: { id: 'T111', title: 'Example task' } },
  { type: 'answerLabel', attrs: { task: 'T112', question: 'surface-check', n: '1', name: 'Option1', answer: '1-Option1' } },
  { type: 'skillLabel', attrs: { name: 'alpacawork', invocation: '/' } },
  { type: 'replyLabel', attrs: { id: 'surface-reply', answeredAt: '2026-01-01T00:00:00.000Z' } },
  { type: 'taskLabel', attrs: { id: 'P1', title: 'Example project' } },
];

test.use({ isolated: true, channel: 'chrome' });
for (const phone of [false, true]) test.describe(`native label surface ${phone ? 'touch' : 'mouse'}`, () => {
  test.use({ viewport: { width: phone ? 390 : 1440, height: 900 }, isMobile: phone, hasTouch: phone });
  // Every kind is the same labelNode and slot (LabelEditor.tsx, atom-surface.tsx); what is pressed is not in this case.
  if (phone) test('native IME deletion consumes exactly one object for a label', async ({ page, runtime }) => {
    configureCoordinator(runtime.root);
    await open(page, runtime, '?agent=1&task=T112'); await writeCoordinator(page);
    // Coordinate-based native caret probes need the entrance clip to expose the complete input.
    await settleMotion(page, page.locator('[data-coordinator-card]'));
    const field = page.locator('[data-one-input]'), ime = await page.context().newCDPSession(page);
    try {
      for (const atom of [atoms[0], atoms[3]]) {
        await field.evaluate((el: any, atom) => {
          el.editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, atom, { type: 'text', text: 'b' }] }] });
          el.editor.commands.setTextSelection(2); el.editor.view.focus();
        }, atom);
        // The native editing text is a + one object replacement character + b. Replacing that one native unit
        // must remove the whole schema atom, rather than touching its display name or requiring extra deletes.
        await ime.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0, replacementStart: 1, replacementEnd: 2 });
        await expect.poll(() => field.evaluate((el: any) => el.editor.getJSON())).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [text('ab')] }] });
        await expect(field).toBeFocused();
      }
    } finally { await ime.detach(); }
  });
});
