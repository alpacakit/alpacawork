/** Test-only Task preparation. Served fixtures write through their owning process, without impersonating a Run. */
import { seedFixtureTask } from '../../tests/helpers/control-fixture.ts';
import { remoteFixture } from '../fixture-writes.ts';
import type { TaskValues } from '@alpacawork/raw';

/** Seed ordinary work: project-level Tasks carry the user's mark; children are internal. */
export function seedTask(root: string, parentId: string, title: string, values: TaskValues = {}): { id: string; hash: string } {
  const remote = remoteFixture(root, { kind: 'task', parentId, title, values });
  if (remote.handled) return remote.value;
  return seedFixtureTask(root, parentId, title, values);
}
