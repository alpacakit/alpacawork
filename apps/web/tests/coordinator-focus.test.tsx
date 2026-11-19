import { setConversationState } from './conversation-fixture';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { applyCoordinatorFocus, focusCoordinator, registerCoordinatorField } from '../src/features/coordinator/editor/draft';
import { useConversation } from '../src/features/coordinator/coordinator';

const original = useConversation.getState();
let release: (() => void) | undefined;
let field: HTMLDivElement;
beforeEach(() => {
  setConversationState({ open: false, focusRequested: false, refresh: async () => {} });
  vi.spyOn(window, 'focus').mockImplementation(() => {});
  field = document.createElement('div'); field.tabIndex = 0; field.textContent = 'words';
});
afterEach(() => { release?.(); release = undefined; field.remove(); setConversationState(original); });

test('a detached input receives a requested handoff once; another connection signal preserves later selection', () => {
  const focus = vi.fn(() => { field.focus(); const range = document.createRange(); range.selectNodeContents(field); range.collapse(false); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); return true; });
  Object.assign(field, { editor: { commands: { focus }, view: { focus: () => field.focus() } } });
  release = registerCoordinatorField(field);
  focusCoordinator();
  expect(focus).not.toHaveBeenCalled();
  document.body.append(field); applyCoordinatorFocus();
  expect(document.activeElement).toBe(field); expect(focus).toHaveBeenCalledTimes(1);
  const range = document.createRange(); range.setStart(field.firstChild!, 0); range.setEnd(field.firstChild!, 2);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  applyCoordinatorFocus();
  expect(focus).toHaveBeenCalledTimes(1); expect(window.getSelection()!.toString()).toBe('wo');
});

test('a pending handoff cancelled by close is not replayed when a field connects', () => {
  focusCoordinator();
  useConversation.getState().setOpen(false);
  document.body.append(field); release = registerCoordinatorField(field); applyCoordinatorFocus();
  expect(document.activeElement).not.toBe(field);
  expect(useConversation.getState().focusRequested).toBe(false);
});
