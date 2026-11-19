import { expect, test } from 'vitest';
import { localTarget, taskIdAtAddress } from '../src/domain/local-path';
import { dto, screenData, tree } from './fixtures';

test('Task ownership does not require a row in the screen index', () => {
  expect(localTarget('/workspace/tasks/T218/files/compare.png', null, '/workspace')).toEqual({ kind: 'task', id: 'T218', path: 'files/compare.png' });
  expect(taskIdAtAddress('T218')).toBe('T218');
});

test('another workspace, malformed Task folder and prefix collisions remain copyable outside paths', () => {
  for (const path of ['/old-workspace/tasks/T218/a.png', '/workspace-extra/tasks/T218/a.png', '/workspace/tasks/T218-copy/a.png', '/workspace/tasks/note/a.png'])
    expect(localTarget(path, null, '/workspace')).toEqual({ kind: 'outside', path });
  expect(localTarget('files/compare.png', null, '/workspace')).toBeNull();
  for (const address of ['tasks/T218', 'T218/files', 'alp/T218']) expect(taskIdAtAddress(address)).toBeNull();
});

test('a local path retains the first exact file, including a folder path with its own file entry', () => {
  const files = ['notes/child.txt', 'notes', 'notes', 'notes/'].map((name, index) => ({
    name, size: index, revision: `rev${index}`, at: '2026-11-04T00:00:00Z',
  }));
  const task = screenData(tree({ tasks: [dto({ files })] })).tasks[0]!;
  for (const prefix of ['', '/workspace/tasks/T1/']) {
    const file = localTarget(`${prefix}notes`, task, '/workspace');
    expect(file).toEqual({ kind: 'task', id: task.id, path: 'notes', file: task.files[1] });
    expect(file?.kind === 'task' && file.file).toBe(task.files[1]);
    const folder = localTarget(`${prefix}notes/`, task, '/workspace');
    expect(folder).toEqual({ kind: 'task', id: task.id, path: 'notes/', file: task.files[3] });
    expect(folder?.kind === 'task' && folder.file).toBe(task.files[3]);
  }
});
