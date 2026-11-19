import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('actual Markdown reference toggles only its card; only the portal Open intends to follow a Task', async () => {
  const { startI18n } = await import('@alpacawork/i18n'); await startI18n();
  const { MarkdownBody } = await import('../src/features/reader/MarkdownBody');
  const { dto, screenData, TestWorkspace, tree, viewsOf } = await import('./fixtures');
  const { queryClient } = await import('../src/data/query-client');
  const { useConnection } = await import('../src/data/connection');
  const { inputAction } = await import('../dev/performance-context');
  queryClient.clear(); useConnection.setState({ state: 'live', offline: false });
  const data = screenData(tree({ tasks: [dto({ id: 'T1' })] }));
  const target = viewsOf(tree({ tasks: [dto({ id: 'T9001', title: 'Reference target', baseState: 'done' })] })).find(view => view.task.id === 'T9001')!;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(target)));
  const follow = vi.fn();
  const actions: (ReturnType<typeof inputAction>)[] = [];
  const capture = (event: Event) => actions.push(inputAction(event));
  document.addEventListener('click', capture, true);
  try {
    render(<TestWorkspace data={data}><MarkdownBody text="T9001" task={null} onFollow={follow} /></TestWorkspace>);
    const reference = screen.getByRole('button', { name: 'T9001' });
    fireEvent.click(reference); await screen.findByText('Reference target');
    expect(actions).toEqual([undefined]); expect(follow).not.toHaveBeenCalled();
    fireEvent.click(reference);
    expect(document.querySelector('[data-task-card-open]')).toBeNull();
    expect(actions).toEqual([undefined, undefined]); expect(follow).not.toHaveBeenCalled();
    fireEvent.click(reference); await screen.findByText('Reference target');
    expect(actions).toEqual([undefined, undefined, undefined]); expect(follow).not.toHaveBeenCalled();
    const open = document.querySelector('[data-task-card-open]')!;
    expect(reference.contains(open)).toBe(false);
    fireEvent.click(open);
    expect(actions).toEqual([undefined, undefined, undefined, 'intent-task-open']);
    expect(follow).toHaveBeenCalledExactlyOnceWith('T9001');
  } finally {
    document.removeEventListener('click', capture, true); cleanup(); queryClient.clear();
  }
});
