import { dto, indexOf, tree } from './fixtures';
import { seedNotices } from './read-fixtures';
import { afterEach, expect, test, vi } from "vitest";
import { queryClient } from "../src/data/query-client";
import { indexKey } from "../src/data/resources";
import { markRead, useReadStore } from "../src/state/read-store";
import { useConnection } from "../src/data/connection";

/** Writes can be sent: the feed is live on a snapshot received in this visit that takes writes. */
const sendable = { state: "live", offline: false, fresh: true, writable: true } as const;
afterEach(() => {
  history.replaceState(null, "", "/");
  useConnection.setState({ state: "connecting", offline: false, fresh: false, writable: false });
  vi.useRealTimers();
  queryClient.clear();
  useReadStore.setState(useReadStore.getInitialState(), true);
});

function opened(url: string) {
  history.replaceState(null, "", url);
  queryClient.setQueryData(indexKey, indexOf(tree({ tasks: [dto({ id: 'T1' })] })));
  const read = vi.fn(async () => true);
  seedNotices(useReadStore, { read, root: '/fixture', status: 'ready', fresh: true, serverRevision: null });
  useConnection.setState(sendable);
  return read;
}

test("opening a task reads it", async () => {
  const read = opened("/?task=T1");
  await markRead("T1");
  expect(read).toHaveBeenCalledTimes(1);
});

test("a page opened with ?agent=1 leaves the reader's news unread", async () => {
  const read = opened("/?agent=1&task=T1");
  await markRead("T1");
  expect(read).not.toHaveBeenCalled();
});

test("nothing is read while writes cannot be sent: out of reach, or a list read back from this device", async () => {
  const read = opened("/?task=T1");
  useConnection.setState({ state: "reconnecting", offline: true });
  await markRead("T1");
  // Restored: reachable, but no snapshot received in this visit yet.
  useConnection.setState({ ...sendable, fresh: false });
  await markRead("T1");
  expect(read).not.toHaveBeenCalled();
});
