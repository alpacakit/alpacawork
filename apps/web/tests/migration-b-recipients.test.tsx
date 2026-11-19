import { expect, test, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import * as attachments from '../src/data/attachments';
import { readDrafts, useDraftStore } from '../src/features/forms/draft-store';
import { useViewStore } from '../src/state/view-store';
import { useConversation } from '../src/features/coordinator/coordinator';
import { setupCoordinator, transport, mountCoordinator, openTask, field, labels, first, second, key } from './migration-b-coordinator-fixture';

setupCoordinator();

test('recipients: an attached file does not hold the label; the opened Task\'s label replaces it and the file stays', async () => {
  transport(); openTask(first.id); await mountCoordinator(true);
  await waitFor(() => expect(labels()).toEqual([first.id]));
  vi.spyOn(attachments, 'uploadAttachment').mockResolvedValue({ name: 'note.txt', path: 'attachments/request/note.txt', absolutePath: '/f/note.txt', size: 4 });
  fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['Note'], 'note.txt', { type: 'text/plain' })] } });
  await waitFor(() => expect(document.querySelectorAll('[data-attachment-state=saved]')).toHaveLength(1));
  openTask(second.id);
  await waitFor(() => expect(labels()).toEqual([second.id]));
  expect(document.querySelectorAll('[data-attachment-state=saved]')).toHaveLength(1);
});

test.each([false, true])('recipients: retained draft survives panel moves, remount and sends only its label (recovered=%s)', async recovered => {
  const { posts } = transport();
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'taskLabel', attrs: { ...first, auto: true } }, { type: 'text', text: ' Keep my saved draft' },
  ] }] };
  const entries = { [key]: { status: 'editing' as const, values: { doc: JSON.stringify(doc), requestId: crypto.randomUUID(),
    ...(recovered ? { phase: 'composing', readerDraftTask: first.id } : {}) } } };
  sessionStorage.setItem('alpacawork-input-drafts-v10', JSON.stringify({ version: 6, entries }));
  useDraftStore.setState(readDrafts());
  expect(useDraftStore.getState().unavailable).toBe(false);
  openTask(first.id); const view = await mountCoordinator(true);
  await waitFor(() => expect(labels()).toEqual([first.id]));
  expect(document.querySelector('[data-reader-task-id]')?.textContent).toBe(useViewStore.getState().selected);
  expect(field().textContent).toContain('Keep my saved draft');
  if (recovered) expect(JSON.parse(sessionStorage.getItem('alpacawork-input-drafts-v10')!).entries[key].values.readerDraftTask).toBe(first.id);
  act(() => useConversation.getState().setOpen(false)); openTask(second.id);
  act(() => useConversation.getState().setOpen(true));
  await waitFor(() => expect(document.querySelector('[data-reader-task-id]')?.textContent).toBe(second.id));
  await waitFor(() => expect(labels()).toEqual([first.id]));
  expect(document.querySelector('[data-reader-task-id]')?.textContent).toBe(useViewStore.getState().selected);
  expect(field().textContent).toContain('Keep my saved draft');
  const saved = JSON.parse(sessionStorage.getItem('alpacawork-input-drafts-v10')!).entries;
  expect(Object.values(saved).filter((entry: any) => entry.values.doc.includes('Keep my saved draft'))).toHaveLength(1);
  // Recreate the component and reload precisely what persisted, rather than seeding a replacement document.
  view.unmount(); useDraftStore.setState(readDrafts()); expect(useDraftStore.getState().unavailable).toBe(false); await mountCoordinator(true);
  await waitFor(() => expect(labels()).toEqual([first.id]));
  expect(document.querySelector('[data-reader-task-id]')?.textContent).toBe(useViewStore.getState().selected);
  expect(field().textContent).toContain('Keep my saved draft');
  fireEvent.click(document.querySelector('[data-ask-send]')!);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]!.tasks).toEqual([first.id]);
  expect(posts[0]).not.toHaveProperty('context');
});
