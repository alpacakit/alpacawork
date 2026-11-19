import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { drawnTaskIds, listNeighbours, ListNavigationProvider, useListNavigation, useListNavigationSource, type ListNavigation } from "../src/features/tree/list-navigation";

afterEach(cleanup);
const row = (id: string) => ({ task: { id } });
test("drawn rows keep the flat list order and each task's first projection", () => {
  const ids = drawnTaskIds({ nodes: [row("T9"), row("T2"), row("T8"), row("T3"), row("T2"), row("T1")] });
  expect(ids).toEqual(["T9", "T2", "T8", "T3", "T1"]);
  expect(listNeighbours(ids, "T2")).toEqual({ at: 1, previous: "T9", next: "T8" });
});

test("boundaries never wrap, absent tasks have no neighbours, duplicates cannot lead back to the same task", () => {
  expect(listNeighbours(["T9", "T2", "T9"], "T9")).toEqual({ at: 0, previous: undefined, next: "T2" });
  expect(listNeighbours(["T9", "T2"], "T2")).toEqual({ at: 1, previous: "T9", next: undefined });
  expect(listNeighbours(["T9", "T2"], "T1")).toEqual({ at: -1, previous: undefined, next: undefined });
  expect(listNeighbours([], "T1")).toEqual({ at: -1, previous: undefined, next: undefined });
});

function Source({ list }: { list: ListNavigation }) { useListNavigationSource(list); return null; }
function Neighbours({ id }: { id: string }) {
  const list = useListNavigation(), { previous, next } = listNeighbours(list.ids, id);
  return <><button disabled={!previous} onClick={() => previous && list.open(previous)}>Previous</button>
    <button disabled={!next} onClick={() => next && list.open(next)}>Next</button></>;
}
test("filter/project changes and list unmount replace the published rows and their ordinary opening action", () => {
  const opened: string[] = [];
  const show = (ids: string[], source = true) => <ListNavigationProvider>
    {source && <Source list={{ ids, open: id => opened.push(id) }} />}<Neighbours id="T2" />
  </ListNavigationProvider>;
  const view = render(show(["T9", "T2", "T3"]));
  fireEvent.click(screen.getByText("Next"));
  expect(opened).toEqual(["T3"]);
  view.rerender(show(["T2", "T9"]));
  expect((screen.getByText("Previous") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("Next"));
  expect(opened).toEqual(["T3", "T9"]);
  view.rerender(show(["T9"]));
  expect((screen.getByText("Next") as HTMLButtonElement).disabled).toBe(true);
  view.rerender(show([], false));
  expect((screen.getByText("Previous") as HTMLButtonElement).disabled).toBe(true);
});
