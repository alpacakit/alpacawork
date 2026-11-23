import { createContext, useContext } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import type { PeopleIndex } from "@/domain/people";
import type { mapWorkspace } from "./map";
import type { WorkspaceInfo } from "./types";
import { sameDrawingSource, type DrawingSource } from "@/lib/drawing";

export type WorkspaceData = ReturnType<typeof mapWorkspace> & { info: WorkspaceInfo; people: PeopleIndex; drawing: DrawingSource };
export type WorkspaceStore = StoreApi<WorkspaceData>;

// The context carries a stable store, not its changing contents. The mapped workspace is
// still made once by Workspace; readers subscribe only to the value they actually use.
export const WorkspaceContext = createContext<WorkspaceStore | null>(null);
export const createWorkspaceStore = (data: WorkspaceData): WorkspaceStore => createStore(() => data);

export function useWorkspaceStore(): WorkspaceStore {
  const store = useContext(WorkspaceContext);
  if (!store) throw new Error("Workspace index is missing");
  return store;
}

export function useWorkspaceSelector<T>(selector: (data: WorkspaceData) => T): T {
  return useStore(useWorkspaceStore(), selector);
}

const notYet = createStore<WorkspaceData | null>(() => null);
/** The page's frame is drawn before the first index arrives: its parts read null until then. */
export function useFrameSelector<T>(selector: (data: WorkspaceData | null) => T): T {
  return useStore((useContext(WorkspaceContext) ?? notYet) as StoreApi<WorkspaceData | null>, selector);
}

const sameItems = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((item, i) => item === b[i]);
const sameSet = <T,>(a: ReadonlySet<T>, b: ReadonlySet<T>) => a.size === b.size && [...a].every((item) => b.has(item));
const sameShelved = (a: WorkspaceData["shelved"], b: WorkspaceData["shelved"]) =>
  a.length === b.length && a.every((item, i) => item.task === b[i]?.task && item.lifecycle === b[i]?.lifecycle);
const sameInfo = (a: WorkspaceInfo, b: WorkspaceInfo) =>
  a.root === b.root && a.rev === b.rev && a.writable === b.writable && a.checkpointAt === b.checkpointAt &&
  a.attachmentBytes === b.attachmentBytes &&
  a.runs === b.runs && sameItems(a.staleIds, b.staleIds) && sameItems(a.home, b.home) &&
  a.presence.state === b.presence.state && a.presence.until === b.presence.until &&
  JSON.stringify(a.host) === JSON.stringify(b.host) &&
  JSON.stringify(a.coordinatorWork) === JSON.stringify(b.coordinatorWork) &&
  JSON.stringify(a.counts) === JSON.stringify(b.counts) && JSON.stringify(a.projects) === JSON.stringify(b.projects) &&
  JSON.stringify(a.errors) === JSON.stringify(b.errors) && JSON.stringify(a.profiles) === JSON.stringify(b.profiles);

/** Reuse equal projections so a different slice of the feed does not notify its readers. */
export function publishWorkspace(store: WorkspaceStore, next: WorkspaceData) {
  const before = store.getState();
  store.setState({ ...next,
    drawing: sameDrawingSource(before.drawing, next.drawing) ? before.drawing : next.drawing,
    tasks: sameItems(before.tasks, next.tasks) ? before.tasks : next.tasks,
    readIds: sameSet(before.readIds, next.readIds) ? before.readIds : next.readIds,
    shelved: sameShelved(before.shelved, next.shelved) ? before.shelved : next.shelved,
    info: sameInfo(before.info, next.info) ? before.info : next.info,
  }, true);
}
