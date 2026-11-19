import { z } from 'zod';
import type { QueryClient } from '@tanstack/react-query';
import type { ProjectShelfDTO } from '@alpacawork/contract/control';
import { readWriteBasis } from '@/data/connection';
import { ApiError } from '@/data/client';
import { sendDirectIntent } from '@/data/direct-write';
import { resources } from '@/data/resources';
import { intentKey } from '@/data/write-intent';
import type { ArchiveRefusal, ShelfTarget } from './archive-types';

export const projectArchiveIntentKey = (root: string, project: string) => intentKey(root, 'task/archive', project);

/** Restore authorizes the catalog the person actually read, including a project absent from normal rows. */
export async function restoreCatalogProject(client: QueryClient, root: string, catalog: ProjectShelfDTO, target: ShelfTarget) {
  if (client.getQueryData(resources.projectShelf(root).queryKey) !== catalog || !catalog.projects.some(project => project.shelf.restoreTarget?.id === target.id && project.shelf.restoreTarget.hash === target.hash))
    return Promise.reject(new ApiError('Restore target is absent from the catalog', 'conflict', 'reread'));
  const basis = readWriteBasis(resources.projectShelf(root).queryKey, catalog.revision);
  return sendDirectIntent(client, intentKey(root, 'task/restore', target.id), { path: 'task/restore', response: 'task', label: target.title },
    () => ({ task: target.id, expectedTaskHash: target.hash }), basis);
}
const runsSchema = z.array(z.string());
/** Lifecycle refusal facts are translated once for the confirmation dialog. */
export function archiveRefusal(error: unknown, rows: readonly { id: string; title: string; state: ArchiveRefusal['tasks'][number]['state'] }[] = []): ArchiveRefusal | null {
  if (!(error instanceof ApiError)) return null;
  if (error.reason?.kind === 'tasks_below_still_at_work') {
    const parsed = z.object({ tasks: z.array(z.string()).transform(ids => ids.map(id => ({ id }))) }).safeParse(error.detail);
    return parsed.success ? { tasks: parsed.data.tasks.map(task => { const row = rows.find(row => row.id === task.id); return row ? { id: row.id, title: row.title, state: row.state } : task; }), runs: [] } : null;
  }
  if (error.reason?.kind === 'task_has_unfinished_runs') {
    const parsed = z.object({ runs: runsSchema }).safeParse(error.detail);
    return parsed.success ? { tasks: [], runs: parsed.data.runs } : null;
  }
  return null;
}
