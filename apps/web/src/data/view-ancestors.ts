import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TaskAncestorHeadDTO } from '@alpacawork/contract/control';
import { isWrittenRead, readerPresentation, subscribeReads } from './read-model';

/**
 * The tasks above an opened Task down to its parent, as its view names them (the heads of its ancestors, finished ones
 * too), below its nearest project: a project is drawn by its square, not as a step. Undefined until a view is held.
 */
export function viewAncestors(view: { ancestors: TaskAncestorHeadDTO[] } | undefined): TaskAncestorHeadDTO[] | undefined {
  if (!view) return;
  let below = view.ancestors.length;
  while (below > 0 && view.ancestors[below - 1]!.kind !== 'project') below--;
  return view.ancestors.slice(below);
}
const same = (a: TaskAncestorHeadDTO[] | undefined, b: TaskAncestorHeadDTO[] | undefined) => a === b
  || !!a && !!b && a.length === b.length && a.every((head, at) => head.id === b[at]!.id && head.title === b[at]!.title);
export function useViewAncestors(root: string, id: string): TaskAncestorHeadDTO[] | undefined {
  const client = useQueryClient();
  const held = useRef<TaskAncestorHeadDTO[] | undefined>(undefined);
  const snapshot = () => {
    const shown = readerPresentation(client, root, id);
    const view = shown.kind === 'view' ? shown.view : shown.kind === 'written' ? shown.earlier : undefined;
    const next = view && !isWrittenRead(view) ? viewAncestors(view) : undefined;
    if (!same(held.current, next)) held.current = next;
    return held.current;
  };
  return useSyncExternalStore(useCallback((changed: () => void) => subscribeReads(client, changed), [client]), snapshot);
}
