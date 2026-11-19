import { beforeAll, beforeEach, afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { startI18n } from '@alpacawork/i18n';
import { queryClient } from '../src/data/query-client';
import { useConnection } from '../src/data/connection';
import { useEveryTaskIndex } from '../src/data/queries';
import { useUrlBootstrap } from '../src/state/bootstrap';
import { useViewStore } from '../src/state/view-store';
import { ProjectMenu } from '../src/features/chrome/ProjectMenu';
import { TestWorkspace, screenData, tree, dto, project, viewsOf } from './fixtures';
import { fakeNavigation, sessionHistory } from './navigation-fake';
import { jsonAnswer } from './receipt-fixture';
import { refusal } from './forms-fixture';

const storage = 'alpacawork.navigation.v2';
const source = () => tree({ tasks: [project(), project({ id: 'P200', title: 'Second project' }), dto({ id: 'T111' })] });
function Bootstrap() { useUrlBootstrap(useEveryTaskIndex()); return <ProjectMenu />; }
function mount(value = source()) { return render(<TestWorkspace data={screenData(value)}><Bootstrap /></TestWorkspace>); }
const saved = () => JSON.parse(localStorage.getItem(storage)!);
const seed = (search: string, root = '/fixture') => localStorage.setItem(storage, JSON.stringify({ root, search }));
const selected = () => useViewStore.getState().project;
beforeAll(() => startI18n());
beforeEach(() => {
  queryClient.clear(); localStorage.clear(); history.replaceState(null, '', '/');
  useViewStore.setState(useViewStore.getInitialState());
  useConnection.setState({ state: 'live', offline: false, fresh: true, writable: true });
  sessionHistory(); fakeNavigation();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => jsonAnswer(viewsOf(source()).find(view => String(url).includes(view.task.id))));
});
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test.each(['/', '/?agent=1', '/?strip=on'])('menu selection and All persist through a new launch at %s', async launch => {
  const first = mount();
  fireEvent.click(document.querySelector('[data-project-trigger]')!);
  fireEvent.click(document.querySelector('[data-project-item="P200"]')!);
  expect(new URLSearchParams(saved().search).get('project')).toBe('P200');
  first.unmount(); history.replaceState(null, '', launch); useViewStore.setState(useViewStore.getInitialState());
  const second = mount();
  await waitFor(() => expect(selected()).toBe('P200'));
  fireEvent.click(document.querySelector('[data-project-trigger]')!);
  expect(document.querySelector('[data-project-item="P200"]')?.getAttribute('aria-checked')).toBe('true');
  fireEvent.click(document.querySelector('[data-project-item="all"]')!);
  expect(new URLSearchParams(saved().search).has('project')).toBe(false);
  second.unmount(); history.replaceState(null, '', launch); useViewStore.setState(useViewStore.getInitialState());
  mount(); await waitFor(() => expect(selected()).toBeNull());
});

test.each(['archived', 'deleted', 'missing'] as const)('a %s saved project falls back to All', async lifecycle => {
  seed('project=P200');
  mount(tree({ tasks: [project(), ...(lifecycle === 'missing' ? [] : [project({ id: 'P200', lifecycle })])] }));
  await waitFor(() => expect(saved().search).toBe(''));
  expect(selected()).toBeNull();
});

test.each(['/?project=P100', '/?q=explicit', '/?task=T111'])('explicit navigation %s takes priority over the saved project', async launch => {
  seed('project=P200'); history.replaceState(null, '', launch); mount();
  await waitFor(() => expect(selected()).toBe(launch.includes('project=') ? 'P100' : null));
  expect(location.search).toContain(launch.slice(2));
});

test('an unavailable saved reader keeps its accepted active project', async () => {
  seed('project=P200&task=T999'); vi.mocked(fetch).mockImplementation(async url => String(url).includes('T999')
    ? refusal(404) : jsonAnswer(viewsOf(source()).find(view => String(url).includes(view.task.id)))); mount();
  await waitFor(() => expect(selected()).toBe('P200'));
  expect(useViewStore.getState().reader.open).toBe(false);
  expect(saved().search).toBe('project=P200');
});

test('a foreign saved project cannot enter an options-only launch', () => {
  seed('project=P200', '/other'); history.replaceState(null, '', '/?agent=1'); mount();
  expect(selected()).toBeNull(); expect(saved().root).toBe('/fixture');
});

test.each(['/', '/?agent=1'])('a stale listed project refused by the server cannot restore at %s', async launch => {
  seed('project=P200'); history.replaceState(null, '', launch);
  vi.mocked(fetch).mockResolvedValue(refusal(404)); mount();
  await waitFor(() => expect(saved().search).toBe(''));
  expect(selected()).toBeNull();
});

test('a reload of an existing All history entry does not adopt a different tab’s saved project', () => {
  seed('project=P200'); history.replaceState({ alpacaworkNavigation: 1 }, '', '/?agent=1'); mount();
  expect(selected()).toBeNull(); expect(saved().search).toBe('');
});

test('choosing a project while a URL task is unresolved saves the project without the unverified task', async () => {
  history.replaceState(null, '', '/?task=T999'); vi.mocked(fetch).mockImplementation(() => new Promise(() => {})); mount();
  act(() => useViewStore.getState().setProject('P200'));
  expect(saved().search).toBe('project=P200');
});
