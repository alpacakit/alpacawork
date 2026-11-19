import { receiveFullIndex } from '../src/data/resources';
import { isWrittenRead, readerPresentation, type TaskRead } from '../src/data/read-model';
import { useWriteIntentStore, intentKey } from '../src/data/write-intent';
import { resources } from '../src/data/resources';
import { seedNotices } from './read-fixtures';
import { compositionClock, timeoutClock } from "./timing";
import { test, expect, onTestFinished, vi } from "vitest";
import { useRef, useState } from "react";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { Dialog, DialogContent, DialogHeading } from "../src/components/ui/dialog";
import { Popup } from "../src/components/ui/popup";
import { i18n } from "@alpacawork/i18n";
import { StateControl } from "../src/features/forms/ReportInputs";
import { useReaderSend } from "../src/features/coordinator/reader-send";
import type { ReaderAdmission } from "../src/features/reader/next-question";
import { Reader } from "../src/features/reader/Reader";
import { useDirectWriteRecovery } from "../src/features/reader/recovery";
import { Toaster } from "../src/components/ui/toaster";
import { useToasts } from "../src/lib/notify";
import { indexKey } from "../src/data/resources";
import type { ControlIndexDTO, TaskViewDTO } from "@alpacawork/contract/control";
import { useDialogStore } from "../src/state/dialog-store";
import { draftKey, useDraftStore } from "../src/features/forms/draft-store";
import { closeInput, openInput } from "../src/state/open-input";
import { useViewStore } from "../src/state/view-store";
import { queryClient } from "../src/data/query-client";
import { useReadStore } from "../src/state/read-store";
import { readTaskIds, taskBaseline } from "../src/data/notice-model";
import type { Task, TaskDetail } from "../src/data/types";
import { indexTasks } from "../src/domain/tasks";
import { TestWorkspace, indexOf, narrowScreen, rowOf, screenData, tree, dto, logEntry, viewsOf, valuesView } from "./fixtures";
import { setupForms, errorToasts, refusal, written, submit, body, unconfirmed, reportData, isOpen, reportPopup, reportTitleField, reportDescriptionField, enter, BEFORE, WRITTEN, deferred } from "./forms-fixture";

setupForms();

/** The page's global observer stays mounted when an admitted body editor closes. */
function GlobalRecovery() { useDirectWriteRecovery(); return null; }

/** A write's answer as the server sends it: the Task as written. */
const answered = (task = dto()) => written(task);

test("Enter and Esc during IME composition are left to the IME: no save, no close", async () => {
  const elapse = compositionClock();
  // The state form writes directly, independent of the conversation input.
  const post = vi.spyOn(globalThis, "fetch").mockResolvedValue(refusal(409));
  const data = screenData(tree({ tasks: [dto({ hash: "a".repeat(64) })] }));
  render(<TestWorkspace data={data}>{reportPopup(data.tasks[0]!)}</TestWorkspace>);
  fireEvent.change(reportTitleField(), { target: { value: "報告" } });
  fireEvent.keyDown(reportTitleField(), { key: "Enter", metaKey: true, isComposing: true });
  // A send would follow the form's check of its values: let that run before saying none went.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(post).not.toHaveBeenCalled();
  expect(useDialogStore.getState().dialog).toMatchObject({ form: "report" });
  elapse(50);
  fireEvent.keyDown(reportTitleField(), { key: "Enter", metaKey: true });
  await waitFor(() => expect(post).toHaveBeenCalledOnce());
});

test("a closed dialog gives the focus back only if nothing took it since: a menu opened meanwhile stays open", async () => {
  function Screen() {
    const [dialog, setDialog] = useState(false);
    const [menu, setMenu] = useState(false);
    const menuAt = useRef<HTMLButtonElement>(null);
    return <>
      <button onClick={() => setDialog(true)}>Settings</button>
      {/* Mounted while open, as the dialog host does, so it remembers the button that opened it. */}
      {dialog && <Dialog open onOpenChange={setDialog}><DialogContent><DialogHeading title="Settings dialog" /></DialogContent></Dialog>}
      <Popup open={menu} onOpenChange={setMenu} label="Menu" anchorRef={menuAt} anchor={<button ref={menuAt} onClick={() => setMenu(true)}>Menu</button>}>
        <button>Item</button>
      </Popup>
    </>;
  }
  render(<Screen />);
  const opener = screen.getByRole("button", { name: "Settings" });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole("dialog", { name: "Settings dialog" });
  const elapse = timeoutClock();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  // The menu is opened before the closed dialog's focus return runs (a click is handled ahead of a timer under load).
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  const item = screen.getByRole("button", { name: "Item" });
  await elapse(50);
  vi.useRealTimers();
  expect(screen.queryByRole("button", { name: "Item" })).toBe(item);
  expect(document.activeElement).toBe(item);
});

test("a sheet (the narrow width's popup) closed with Esc gives the focus back to the button that opened it", async () => {
  const narrow = narrowScreen(true);
  try {
    const data = reportData();
    render(<TestWorkspace data={data}><StateControl task={data.tasks[0]!} /></TestWorkspace>);
    const opener = screen.getByRole("button", { name: "Change state" });
    opener.focus();
    fireEvent.click(opener);
    const sheet = await screen.findByRole("dialog", { name: `Change the state of ${data.tasks[0]!.id}` });
    expect(sheet.getAttribute("data-slot")).toBe("sheet");
    // The popover's width is the popover's: the sheet spans the screen.
    expect(sheet.className).toContain("inset-x-0");
    expect(sheet.className).not.toMatch(/(^|\s)w-\d/);
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(useDialogStore.getState().dialog).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  } finally { narrow.restore(); }
});

/** The tasks the reader has read in the displayed snapshot. */
const readNow = () => {
  const { checkpoint, reads } = useReadStore.getState();
  return readTaskIds(queryClient.getQueryData<ControlIndexDTO>(indexKey)!.tasks, checkpoint, reads);
};

test("the state popup ignores Esc during IME composition and closes on a plain Esc; the sheet does the same", async () => {
  vi.spyOn(globalThis, "fetch");
  const data = reportData();
  const check = async () => {
    const elapse = compositionClock();
    const field = reportTitleField();
    fireEvent.change(field, { target: { value: "Draft" } });
    fireEvent.keyDown(field, { key: "Escape", isComposing: true });
    expect(useDialogStore.getState().dialog).toMatchObject({ form: "report" });
    expect((reportTitleField()).value).toBe("Draft");
    elapse(50);
    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() => expect(useDialogStore.getState().dialog).toBeNull());
    expect(screen.queryByRole("textbox")).toBeNull();
  };
  const view = render(<TestWorkspace data={data}>{reportPopup(data.tasks[0]!)}</TestWorkspace>);
  await check();
  view.unmount();
  const narrow = narrowScreen(true);
  try {
    render(<TestWorkspace data={data}>{reportPopup(data.tasks[0]!)}</TestWorkspace>);
    await screen.findByRole("dialog", { name: `Change the state of ${data.tasks[0]!.id}` });
    await check();
  } finally { narrow.restore(); }
});

test("the state popup keeps what is typed when the width crosses the narrow line; it can send without the coordinator input", async () => {
  const narrow = narrowScreen(false);
  try {
    const data = reportData();
    render(<TestWorkspace data={data}>{reportPopup(data.tasks[0]!)}</TestWorkspace>);
    fireEvent.change(reportTitleField(), { target: { value: "Kept" } });
    fireEvent.change(reportDescriptionField(), { target: { value: "Work continues." } });
    // Its intent goes through the coordinator's input, which is not on this screen.
    expect(submit("Update").disabled).toBe(false);
    narrow.set(true);
    expect(await screen.findByRole("dialog", { name: `Change the state of ${data.tasks[0]!.id}` })).toBeTruthy();
    expect((reportTitleField()).value).toBe("Kept");
    expect((reportDescriptionField()).value).toBe("Work continues.");
    narrow.set(false);
    expect((reportTitleField()).value).toBe("Kept");
    expect(submit("Update").disabled).toBe(false);
  } finally { narrow.restore(); }
});

