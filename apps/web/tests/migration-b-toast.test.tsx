import { test, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DialogHost } from '../src/features/shell/DialogHost';
import { Toaster } from '../src/components/ui/toaster';
import { useDirectWriteRecovery } from '../src/features/reader/recovery';
import { useDialogStore } from '../src/state/dialog-store';
import { TestWorkspace } from './fixtures';
import { setupForms } from './forms-fixture';
import { problemResponse } from './problem';

setupForms();
function Recovery() { useDirectWriteRecovery(); return <><DialogHost /><Toaster /></>; }
const open = () => {
  render(<TestWorkspace><Recovery /></TestWorkspace>);
  act(() => useDialogStore.getState().openProject());
  return screen.getByRole('dialog', { name: 'New project' });
};

test('dialog check is not duplicated; after closing, the same operation has a Check toast', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url) === '/api/commands/task/new') throw new TypeError('lost');
    return new Response(JSON.stringify({ folder: '/fixture', home: '/home', entries: [], truncated: false }));
  });
  const dialog = open();
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: '見本' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.querySelector('[data-toast]')).toBeTruthy());
  act(() => useDialogStore.getState().openProject());
  const reopened = screen.getByRole('dialog', { name: 'New project' });
  await within(reopened).findByRole('button', { name: 'Check' });
  expect(document.querySelectorAll('[data-toast]')).toHaveLength(0);
  fireEvent.click(within(reopened).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const toast = document.querySelector<HTMLElement>('[data-toast]')!;
  expect(toast.textContent).toContain('見本');
  expect(within(toast).getByRole('button', { name: 'Check' })).toBeTruthy();
});

test('folder failure persists and Retry performs another read', async () => {
  let reads = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url).startsWith('/api/workspace/folders')) reads++;
    return problemResponse('unavailable', 'x');
  });
  const dialog = open();
  fireEvent.click(dialog.querySelector('[data-folder-walk]')!);
  await waitFor(() => expect(dialog.querySelector('[data-folder-list] [data-read-failure]')).toBeTruthy());
  const before = reads;
  fireEvent.click(within(dialog.querySelector<HTMLElement>('[data-folder-list] [data-read-failure]')!).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(reads).toBeGreaterThan(before));
  expect(dialog.querySelector('[data-folder-list] [data-read-failure]')).toBeTruthy();
});
