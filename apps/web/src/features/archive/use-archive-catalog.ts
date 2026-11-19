import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useWorkspaceInfo, useWriteDisabled } from '@/data/queries';
import { readState, resources, recoverReads } from '@/data/resources';
import type { ProjectShelfDTO } from '@alpacawork/contract/control';
import { ApiError } from '@/data/client';
import { restoreCatalogProject } from './archive-operations';
import type { ShelfTarget } from './archive-types';

/** Both restoration entrances consume the same managed catalog and its actual acquisition basis. */
export function useArchiveCatalog() {
  const root = useWorkspaceInfo(info => info.root), client = useQueryClient();
  const options = resources.projectShelf(root), query = useQuery(options);
  const state = readState<ProjectShelfDTO>(client, options.queryKey);
  const disabled = useWriteDisabled(options.queryKey);
  const restore = useMutation({
    meta: { errorToast: false },
    mutationFn: (target: ShelfTarget) => restoreCatalogProject(client, root, state.data!, target),
  });
  return {
    shelf: { ...query, data: state.data, refetch: async () => { await recoverReads(client, [options.queryKey]); return query; } },
    restoreDisabled: disabled,
    onRestore: (target: ShelfTarget) => { if (!disabled && state.data && !restore.isPending) restore.mutate(target); },
    restoring: restore.isPending ? restore.variables?.id : null,
    restoreFailure: restore.isError && !(restore.error instanceof ApiError && restore.error.code === 'cancelled') && restore.variables ? { id: restore.variables.id, error: restore.error } : null,
  };
}
