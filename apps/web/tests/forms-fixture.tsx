import { beforeAll, beforeEach, afterEach, vi } from "vitest";
import { cleanup, screen, fireEvent } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { notify, useToasts } from "../src/lib/notify";
import { StateControl } from "../src/features/forms/ReportInputs";
import { useDialogStore } from "../src/state/dialog-store";
import { openInput } from "../src/state/open-input";
import { useViewStore } from "../src/state/view-store";
import { useConnection } from "../src/data/connection";
import { queryClient } from "../src/data/query-client";
import { useReadStore } from "../src/state/read-store";
import type { Task } from "../src/data/types";
import { headOf, screenData, tree, dto } from "./fixtures";
import { problemResponse } from "./problem";

/** A refusal as the server answers it: 400 a refused input, 404 a missing Task, 409 a changed Task, 503 an unconfirmed save. */
export const refusal = (status: 400 | 404 | 409 | 503) =>
  problemResponse(({ 400: "invalid_input", 404: "not_found", 409: "conflict", 503: "save_unconfirmed" } as const)[status], "Server refusal");

/** A task write's answer: the task as written (and the tree, which the feed delivers anyway). */
export const written = (task = dto()) => new Response(JSON.stringify({ task: headOf(task), outcome: { kind: "recorded" } }), { status: 200 });

export const success = () => written();

export const submit = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

export const body = (fetcher: ReturnType<typeof vi.spyOn>, index = 0) => JSON.parse(String((fetcher.mock.calls[index]?.[1] as RequestInit)?.body));

export const unconfirmed = () => i18n.t("forms:writeFailure.unconfirmed");

/** The inline frames have no empty error line; the dialogs keep one. */
/** The error toasts on screen now (notify.error and notify.failure both end here). */
export const errorToasts = () => useToasts.getState().toasts.filter(toast => toast.kind === "error");

/** Every toast goes, through notify (so its clock goes too): one test's toasts are not the next one's. */
export const clearToasts = () => { for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id); };

export const alertText = () => screen.queryByRole("alert")?.textContent ?? "";

export function reportData(hash = "a".repeat(64)) { return screenData(tree({ tasks: [dto({ hash })] })); }


/** Whether `form` is the open input for `taskId` (opening is done once; a rerender that feeds new data must not open it again). */
export const isOpen = (form: string, taskId: string | null) => { const dialog = useDialogStore.getState().dialog; return dialog?.kind === "input" && dialog.form === form && dialog.taskId === taskId; };

/** The state popover of the card (State and report), opened as its label opens it. */
export const reportPopup = (task: Task) => { if (!isOpen("report", task.id)) openInput({ form: "report", taskId: task.id, answerCard: null }); return <StateControl task={task} />; };

export const reportTitleField = () => screen.getByRole("textbox", { name: i18n.t("forms:reportForm.reportTitle") }) as HTMLInputElement;

export const reportDescriptionField = () => screen.getByRole("textbox", { name: i18n.t("forms:reportForm.reportDescription") }) as HTMLTextAreaElement;

export const enter = (element: Element) => fireEvent.keyDown(element, { key: "Enter" });

export const BEFORE = "b".repeat(64), WRITTEN = "e".repeat(64);

export const answer = (value: unknown) => new Response(JSON.stringify(value));

// The lifetime of an input against other inputs, surfaces and the IME.
export const deferred = () => { let answer!: (value: Response) => void; const promise = new Promise<Response>((resolve) => { answer = resolve; }); return { promise, answer }; };

/** Register the same isolated starting state in every suite that uses this fixture. */
export function setupForms() {
  /**
   * The inputs of the screen, each drawn in the reader: the state popover (report), the
   * composer in the reader, the task pane's body editor; and the settings
   * dialog. Every input sends the hash it opened with. A draft keeps its failure
   * until reopened, as the dialogs did; the state report keeps nothing once closed.
   */
  beforeAll(() => startI18n());
  beforeEach(() => {
    queryClient.clear();
    useConnection.setState({ offline: false });
    useDialogStore.setState({ dialog: null });
    useViewStore.setState(useViewStore.getInitialState());
    useReadStore.setState(useReadStore.getInitialState(), true);
    clearToasts();
  });
  afterEach(() => { cleanup(); clearToasts(); vi.restoreAllMocks(); });
}
