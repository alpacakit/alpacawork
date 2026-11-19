// A dialog's title takes the focus on opening and stands outside the body that scrolls: the keys that scroll a page
// still move that body from there, and a key held with Shift (selecting the title's words) is left to the browser.
import { afterEach, beforeAll, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { startI18n } from '@alpacawork/i18n';
import { Dialog, DialogBody, DialogContent, DialogHeading } from '@/components/ui/dialog';
beforeAll(() => startI18n());
afterEach(cleanup);

it('scroll keys pressed on the focused title move the body, and Shift with an arrow does not', async () => {
  render(<Dialog open onOpenChange={() => {}}><DialogContent aria-describedby={undefined}>
    <DialogHeading title="Long dialog" /><DialogBody data-testid="body">words</DialogBody>
  </DialogContent></Dialog>);
  await waitFor(() => expect(document.activeElement?.getAttribute('data-slot')).toBe('dialog-title'));
  const title = document.activeElement as HTMLElement, body = screen.getByTestId('body');
  Object.defineProperties(body, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 1000 } });
  expect(fireEvent.keyDown(title, { key: 'PageDown' })).toBe(false);
  expect(body.scrollTop).toBe(180);
  expect(fireEvent.keyDown(title, { key: 'ArrowDown', shiftKey: true })).toBe(true);
  expect(body.scrollTop).toBe(180);
  fireEvent.keyDown(title, { key: 'Home' });
  expect(body.scrollTop).toBe(0);
});
