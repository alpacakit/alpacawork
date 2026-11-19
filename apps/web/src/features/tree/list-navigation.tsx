import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

/** A list publishes the rows it actually draws, with its own ordinary row-opening action.
 * This is a read-only projection of that list, never a second sort or reader history. */
export type ListNavigation = {
  ids: readonly string[];
  open: (id: string) => void;
  /** Search keeps its existing count and explicit next-page step. */
  total?: number;
  loadNext?: () => Promise<string | null>;
};
const empty: ListNavigation = { ids: [], open: () => {} };
const makeStore = () => createStore<{ list: ListNavigation }>(() => ({ list: empty }));
// A reader mounted without a list has no adjacent rows.
const noList = makeStore();
const ListContext = createContext<ReturnType<typeof makeStore> | null>(null);

export function ListNavigationProvider({ children }: { children: ReactNode }) {
  const [store] = useState(makeStore);
  return <ListContext value={store}>{children}</ListContext>;
}

/** Publish after the list commits, so the reader follows exactly the rows on screen.
 * Scrolling out of the viewport does not remove a row; folding or hiding it does. */
export function useListNavigationSource(list: ListNavigation) {
  const store = useContext(ListContext);
  useLayoutEffect(() => { store?.setState({ list }); }, [store, list]);
  useLayoutEffect(() => () => { store?.setState({ list: empty }); }, [store]);
}

export function useListNavigation() {
  const store = useContext(ListContext);
  return useStore(store ?? noList, state => state.list);
}

/** The unique task IDs in the flat list's rendering order. */
export function drawnTaskIds(group: { nodes: readonly { task: { id: string } }[] }): string[] {
  const ids = new Set<string>();
  for (const node of group.nodes) ids.add(node.task.id);
  return [...ids];
}

/** No wrap and no guessed position for a task absent from the current list. */
export function listNeighbours(ids: readonly string[], id: string) {
  const unique = [...new Set(ids)];
  const at = unique.indexOf(id);
  return { at, previous: at > 0 ? unique[at - 1] : undefined, next: at < 0 ? undefined : unique[at + 1] };
}
