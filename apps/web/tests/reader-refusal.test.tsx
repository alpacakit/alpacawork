import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { notify, useToasts } from '../src/lib/notify';
import { i18n, startI18n } from '@alpacawork/i18n';
import { ApiError } from '../src/data/client';
import { ownRecovery, readerFailure, clearRecovery, dismissRecovery } from '../src/features/reader/recovery';
import { dto, screenData, tree } from './fixtures';

beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); dismissRecovery(task.id, 'unknown-write'); for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id); useToasts.setState({ hidden: new Set() }); vi.restoreAllMocks(); });
const task = screenData(tree({ tasks: [dto({ title: 'Review card' })] })).tasks[0]!;

test('an actual unknown write still offers Check for that same operation', () => {
  const error = vi.spyOn(notify, 'error'), check = vi.fn();
  ownRecovery(task.id, 'unknown-write');
  expect(readerFailure(task, 'hold', new ApiError('reply lost'), check, 'unknown-write')).toBe(true);
  const action = error.mock.calls[0]![1]!.action!;
  expect(action!.label).toBe(i18n.t('reader:recovery.check'));
  action.run();
  expect(check).toHaveBeenCalledOnce();
});

for (const retry of ['check', 'reread'] as const) test(`a hidden operation cannot hide a later ${retry === 'check' ? 'Check' : 'Open'} on the same task`, () => {
  const check = vi.fn();
  ownRecovery(task.id, 'old');
  readerFailure(task, 'hold', new ApiError('lost', 'network_error', 'check'), check, 'old');
  notify.hide('reader-operation:old');
  readerFailure(task, 'hold', new ApiError('lost again', 'network_error', 'check'), check, 'old');
  expect(useToasts.getState().toasts.find(t => t.id === 'reader-operation:old')).toBeUndefined();
  ownRecovery(task.id, 'new');
  expect(useToasts.getState().hidden.has('reader-operation:old')).toBe(false);
  readerFailure(task, 'hold', new ApiError('new failure', 'conflict', retry), check, 'new');
  expect(useToasts.getState().toasts.find(t => t.id === 'reader-operation:new')?.action?.label)
    .toBe(i18n.t(retry === 'check' ? 'reader:recovery.check' : 'reader:recovery.latest'));
  notify.hide('reader-operation:new');
  clearRecovery(task.id, 'new');
  expect(useToasts.getState().hidden.size).toBe(0);
  dismissRecovery(task.id, 'new');
});
