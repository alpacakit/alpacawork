import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { navigateWhen } from "../src/features/forms/accept-write";
import { queryClient } from "../src/data/query-client";
import { useViewStore } from "../src/state/view-store";
import { useDialogStore } from "../src/state/dialog-store";
import { indexKey } from "../src/data/resources";
import { indexOf, tree } from "./fixtures";

const key = ["accept-write-test"];
const heard = () => queryClient.setQueryData(key, Math.random());
const index = indexOf(tree());
beforeEach(() => { queryClient.setQueryData(indexKey, index); });
afterEach(() => { useViewStore.setState({ project: null, selected: null }); useDialogStore.setState({ dialog: null }); queryClient.clear(); });

test("the view moves at once when ready, or when the read says so later", () => {
  const now = vi.fn();
  navigateWhen(() => true, now);
  expect(now).toHaveBeenCalledTimes(1);
  let ready = false;
  const later = vi.fn();
  navigateWhen(() => ready, later);
  heard();
  expect(later).not.toHaveBeenCalled();
  ready = true;
  heard(); heard();
  expect(later).toHaveBeenCalledTimes(1);
});

test.each([
  ["another project", () => useViewStore.setState({ project: "P2" })],
  ["a task", () => useViewStore.setState({ selected: "T2" })],
  ["a dialog", () => useDialogStore.setState({ dialog: { kind: "settings" } as never })],
])("once the person opens %s, the view stays where they are, however late the read arrives", (_, move) => {
  let ready = false;
  const navigate = vi.fn();
  navigateWhen(() => ready, navigate);
  move();
  ready = true;
  heard();
  expect(navigate).not.toHaveBeenCalled();
});

test("a read of another session moves nothing, then or later", () => {
  let ready = false;
  const navigate = vi.fn();
  navigateWhen(() => ready, navigate);
  ready = true;
  queryClient.setQueryData(indexKey, { ...index, generation: "another" });
  heard();
  expect(navigate).not.toHaveBeenCalled();
});
