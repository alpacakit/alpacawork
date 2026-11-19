import { beforeAll, afterEach, beforeEach, test, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { startI18n, i18n } from '@alpacawork/i18n';
import { queryClient } from '../src/data/query-client';
import { ProjectArchiveSection } from '../src/features/archive/ProjectArchiveSection';
import { ProjectsSettingsTab } from '../src/features/panels/ProjectsSettingsTab';
import { DialogHost } from '../src/features/shell/DialogHost';
import { useDialogStore } from '../src/state/dialog-store';
import { archiveRefusal } from '../src/features/archive/archive-operations';
import { ApiError } from '../src/data/client';
import { useConnection } from '../src/data/connection';
import { tree, screenData, TestWorkspace, dto, headOf } from './fixtures';
import { jsonAnswer } from './receipt-fixture';

beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
beforeEach(() => { queryClient.clear(); useConnection.setState({ state: 'live', offline: false, writable: true, fresh: true }); });
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

test('project archive cannot send while dirty or saving; saved hash and callback cross the boundary', async () => {
  const source = tree({ tasks: [] }), project = source.tasks.find(task => task.kind === 'project')!, data = screenData(source);
  const onArchived = vi.fn();
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonAnswer({ task: headOf({ ...project, lifecycle: 'archived', version: 2, hash: 'b'.repeat(64) }) }));
  const part = (dirty: boolean, saving: boolean) => <TestWorkspace data={data}><ProjectArchiveSection project={project}
    dirty={dirty} saving={saving} onArchived={onArchived} /></TestWorkspace>;
  const offered = () => screen.getByRole('button', { name: 'Archive…' }) as HTMLButtonElement;
  const mounted = render(part(true, false));
  expect(offered().disabled).toBe(true);
  mounted.rerender(part(false, true));
  expect(offered().disabled).toBe(true); expect(fetcher).not.toHaveBeenCalled();
  mounted.rerender(part(false, false));
  fireEvent.click(screen.getByRole('button', { name: 'Archive…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  await waitFor(() => expect(onArchived).toHaveBeenCalledTimes(1));
  const sent = fetcher.mock.calls.find(([url]) => String(url).includes('task/archive'))!;
  expect(JSON.parse(String(sent[1]?.body))).toMatchObject({ task: project.id, expectedTaskHash: project.hash });
});

test('the projects tab lists every project, marks the archived ones, and opens each one\'s settings, where an archived one is restored from the catalog read', async () => {
  const source = tree({ tasks: [] }), listed = source.tasks.find(task => task.kind === 'project')!, data = screenData(source), hash = 'c'.repeat(64);
  const target = { id: 'P200', title: 'Archived fixture', color: '#39659b', hash };
  const catalog = { revision: 'a'.repeat(64), projects: [{ ...target, parentId: null, lifecycle: 'archived',
    shelf: { listed: false, shelvedBy: [{ ...target, lifecycle: 'archived' }], restoreTarget: target } }] };
  const restored = dto({ id: target.id, title: target.title, hash: target.hash, kind: 'project', path: 'tasks/P200', parentId: null, version: 2 });
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => String(url).includes('project/shelf') ? jsonAnswer(catalog) : jsonAnswer({ task: headOf(restored) }));
  useDialogStore.setState(useDialogStore.getInitialState());
  render(<TestWorkspace data={data}><ProjectsSettingsTab /><DialogHost /></TestWorkspace>);
  const row = (id: string) => document.querySelector(`[data-project-row="${id}"]`)!;
  await waitFor(() => expect(row(target.id)).toBeTruthy());
  expect(row(listed.id).querySelector('[data-shelf-mark]')).toBeNull();
  expect(row(target.id).querySelector('[data-shelf-mark="archived"]')?.textContent).toBe('Archived');
  fireEvent.click(row(listed.id).querySelector('button')!);
  expect(useDialogStore.getState().dialog).toEqual({ kind: 'project', project: listed.id });
  fireEvent.click(row(target.id).querySelector('button')!);
  expect(useDialogStore.getState().dialog).toEqual({ kind: 'project', project: target.id });
  const restore = await screen.findByRole('button', { name: 'Restore' });
  await waitFor(() => expect((restore as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(restore);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('task/restore'))).toBe(true));
  const sent = fetcher.mock.calls.find(([url]) => String(url).includes('task/restore'))!;
  expect(JSON.parse(String(sent[1]?.body))).toMatchObject({ task: target.id, expectedTaskHash: target.hash });
});

test('archive refusal translates task and unfinished-run facts once', () => {
  expect(archiveRefusal(new ApiError('Busy', 'conflict', 'reread', { tasks: ['T9'] }, [], { kind: 'tasks_below_still_at_work', task: 'T1', working: 'T9' })))
    .toEqual({ tasks: [{ id: 'T9' }], runs: [] });
  expect(archiveRefusal(new ApiError('Busy', 'conflict', 'reread', { runs: ['R9'] }, [], { kind: 'task_has_unfinished_runs' })))
    .toEqual({ tasks: [], runs: ['R9'] });
  expect(archiveRefusal(new ApiError('Malformed', 'conflict', 'reread', { tasks: 'T9' }, [], { kind: 'tasks_below_still_at_work', task: 'T1', working: 'T9' }))).toBeNull();
});


test('an unknown archive checks the fixed operation and closes through onArchived only after confirmation', async () => {
  const source = tree({ tasks: [] }), project = source.tasks.find(task => task.kind === 'project')!, data = screenData(source);
  const onArchived = vi.fn();
  let writes = 0;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ++writes === 1
    ? new Response(JSON.stringify({ error: { code: 'unavailable', message: 'Result unknown', retry: 'check' } }), { status: 503 })
    : jsonAnswer({ task: headOf({ ...project, lifecycle: 'archived', version: 2, hash: 'd'.repeat(64) }) }));
  render(<TestWorkspace data={data}><ProjectArchiveSection project={project} dirty={false} saving={false} onArchived={onArchived} /></TestWorkspace>);
  fireEvent.click(screen.getByRole('button', { name: 'Archive…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Check' }).length).toBe(1));
  expect(onArchived).not.toHaveBeenCalled();
  expect(document.querySelector('[data-archive-submit]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  fireEvent.click(document.querySelector('[data-archive-submit]')!);
  await waitFor(() => expect(onArchived).toHaveBeenCalledTimes(1));
  expect(fetcher).toHaveBeenCalledTimes(2);
  const [first, second] = fetcher.mock.calls;
  expect(second![1]?.body).toBe(first![1]?.body);
  expect(new Headers(second![1]?.headers).get('X-Alpacawork-Op-Id')).toBe(new Headers(first![1]?.headers).get('X-Alpacawork-Op-Id'));
});
