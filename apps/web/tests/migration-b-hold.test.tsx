import { test, expect, vi } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { headOf, TestWorkspace, dto, logEntry, screenData, tree } from './fixtures';
import { setupForms, reportPopup, reportTitleField, reportDescriptionField } from './forms-fixture';
import { useWriteIntentStore } from '../src/data/write-intent';
import { useDialogStore } from '../src/state/dialog-store';

setupForms();
for (const origin of ['todo', 'doing', 'error', 'waiting', 'done', 'stopped'] as const) {
  test(`state form holds ${origin} and restores the original state`, async () => {
    const reports: Record<string, any>[] = [], paths: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      paths.push(String(url));
      expect(String(url)).toBe('/api/task/report');
      expect(init?.method).toBe('POST');
      const input = JSON.parse(String(init?.body)); reports.push(input);
      return new Response(JSON.stringify({ task: headOf(dto({ state: input.state, baseState: origin })), outcome: { kind: 'recorded' } }));
    });
    const before = logEntry({ id: 'Lbefore', kind: 'linked', fromState: 'todo', toState: origin });
    let data = screenData(tree({ tasks: [dto({ state: origin, log: [logEntry(), before] })] }));
    let view = render(<TestWorkspace data={data}>{reportPopup(data.tasks[0]!)}</TestWorkspace>);
    fireEvent.click(document.querySelector('[data-state-choice=hold]')!);
    fireEvent.change(reportTitleField(), { target: { value: 'Hold any state' } });
    fireEvent.change(reportDescriptionField(), { target: { value: 'Review later' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]).toMatchObject({ task: 'T1', state: 'held', expectedTaskHash: data.tasks[0]!.hash,
      title: 'Hold any state', description: 'Review later' });
    expect(reports[0]!.opId).toEqual(expect.any(String));
    await waitFor(() => expect(Object.values(useWriteIntentStore.getState().entries).every(entry => entry.status === 'confirmed')).toBe(true));
    await waitFor(() => expect(useDialogStore.getState().dialog).toBeNull());
    view.unmount();
    // The server now supplies the retained base state; History is not its owner.
    data = screenData(tree({ tasks: [dto({ state: 'held', baseState: origin, log: [logEntry(), before,
      logEntry({ id: 'Lhold', kind: 'reported', fromState: origin, toState: 'held' }),
      logEntry({ id: 'Lrepeat', kind: 'reported', fromState: null, toState: null })] })] }));
    view = render(<TestWorkspace data={data}>{reportPopup(data.tasks[0]!)}</TestWorkspace>);
    const restore = document.querySelector<HTMLElement>('[data-state-choice=unhold]')!;
    expect(restore).toBeTruthy();
    const words = { todo: 'Not started', doing: 'In progress', error: 'Error', waiting: 'Awaiting review', done: 'Done', stopped: 'Stopped' };
    expect(restore.textContent).toContain(words[origin]);
    fireEvent.click(restore);
    fireEvent.change(reportTitleField(), { target: { value: 'Restore original state' } });
    fireEvent.change(reportDescriptionField(), { target: { value: 'Ready now' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(reports).toHaveLength(2));
    expect(reports[1]).toMatchObject({ task: 'T1', state: origin, expectedTaskHash: data.tasks[0]!.hash,
      title: 'Restore original state', description: 'Ready now' });
    expect(reports[1]!.opId).not.toBe(reports[0]!.opId);
    expect(paths).toEqual(['/api/task/report', '/api/task/report']);
    await waitFor(() => expect(Object.values(useWriteIntentStore.getState().entries).every(entry => entry.status === 'confirmed')).toBe(true));
    await waitFor(() => expect(useDialogStore.getState().dialog).toBeNull());
  });
}
