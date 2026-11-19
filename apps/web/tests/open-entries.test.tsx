import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { SearchResults } from "../src/features/chrome/SearchResults";
import { Reader } from "../src/features/reader/Reader";
import { queryClient } from "../src/data/query-client";
import { useDialogStore } from "../src/state/dialog-store";
import { useViewStore } from "../src/state/view-store";
import { TestWorkspace, dto, pointerCanHover, screenData, seedSearch, tree } from "./fixtures";

const parent = dto({ id: "T1", title: "Parent" });
const child = dto({ id: "T12", parentId: "T1", path: "tasks/T12", title: "Child", body: "Read Parent" });
const data = () => screenData(tree({ tasks: [parent, child] }));

beforeAll(() => startI18n());
beforeEach(() => {
  useViewStore.setState(useViewStore.getInitialState());
  useDialogStore.setState({ dialog: null });
});
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

test("a search row keeps the condition and opens its detail beside the list", () => {
  useViewStore.getState().setQuery("Child");
  const workspace = data();
  seedSearch("/fixture", "Child", ["T12"]);
  render(<TestWorkspace data={workspace}><SearchResults /></TestWorkspace>);
  fireEvent.click(document.querySelector<HTMLElement>('[data-result="T12"]')!);
  expect(useViewStore.getState()).toMatchObject({ selected: child.id, query: "Child", reader: { open: true } });
  expect(document.querySelectorAll("[data-result]")).toHaveLength(1);
});

test("an ancestor opens through Reader.follow and the path ends in the current task ID", () => {
  pointerCanHover();
  useViewStore.getState().openTask(child.id, { reader: true });
  render(<TestWorkspace data={data()}><Reader mode="docked" /></TestWorkspace>);
  const path = screen.getByRole("navigation", { name: /task path|Task path/i });
  expect(path.querySelector("[data-reader-task-id]")?.textContent).toBe("T12");
  fireEvent.click(within(path).getByRole("button", { name: /Parent$/ }));
  expect(useViewStore.getState()).toMatchObject({ selected: parent.id, reader: { open: true } });
  // This component-only test has no URL bridge and therefore no browser history entry.
  expect(screen.queryByRole("button", { name: /Back to Child/ })).toBeNull();
});

test("where the pointer cannot hover, an ancestor's press follows it without its card", () => {
  useViewStore.getState().openTask(child.id, { reader: true });
  render(<TestWorkspace data={data()}><Reader mode="docked" /></TestWorkspace>);
  const path = screen.getByRole("navigation", { name: /task path|Task path/i });
  fireEvent.click(within(path).getByRole("button", { name: /Parent$/ }));
  expect(useViewStore.getState()).toMatchObject({ selected: parent.id, reader: { open: true } });
  expect(document.querySelector("[data-badge-card]")).toBeNull();
});
