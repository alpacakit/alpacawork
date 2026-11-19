import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import { Reader } from "../src/features/reader/Reader";
import { useDraftStore } from "../src/features/forms/draft-store";
import { useDialogStore } from "../src/state/dialog-store";
import { useViewStore } from "../src/state/view-store";
import { TestWorkspace, dto, screenData, tree } from "./fixtures";
import { useConnection } from "../src/data/connection";
import { TaskActionSlot } from "../src/features/coordinator/task-action-slot";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
beforeEach(() => {
  useViewStore.setState(useViewStore.getInitialState());
  useDialogStore.setState({ dialog: null });
  useDraftStore.setState({ entries: {}, unavailable: false });
  sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const open = (profiles = tree().profiles) => {
  const data = screenData(tree({ tasks: [dto({ title: "Title" })], profiles }));
  act(() => useViewStore.getState().openTask("T1", { reader: true, pane: "task" }));
  // The conversation's row over the input, where the reader draws its task actions.
  return render(<TestWorkspace data={data}><TaskActionSlot /><Reader mode="docked" /></TestWorkspace>);
};

test("History keeps its reading surface on an unplaced task; person and placement tabs are absent", () => {
  open();
  expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
  expect(document.querySelector("[data-report-feed]")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByRole("button", { name: "Assign agents" })).toBeNull();
});

// Sending stays blocked while offline (forms.test: "offline blocks sending…"); opening the state form does not.
test("stopped updates write nothing in the full text: the progress line alone says it", () => {
  useConnection.setState({ state: "reconnecting", offline: true, failures: 1 });
  try {
    open();
    expect(screen.queryByText(/Updates have stopped/)).toBeNull();
  } finally { useConnection.setState({ state: "live", offline: false, failures: 0 }); }
});

test("a file opened from a descendant keeps the list row to return to", () => {
  const row = document.createElement("button");
  document.body.append(row);
  try {
    useViewStore.setState({ selected: "T1" });
    useViewStore.getState().openTask("T12", { reader: true, returnTo: row });
    expect(useViewStore.getState().reader.returnTo).toMatchObject({ element: row, selected: "T1" });
    useViewStore.getState().openTaskFile("T12", "report.md");
    expect(useViewStore.getState()).toMatchObject({ view: "T12/report.md", reader: { returnTo: { element: row, selected: "T1" } } });
    useViewStore.getState().closeReader();
    expect(useViewStore.getState().selected).toBe("T1");
  } finally { row.remove(); }
});
