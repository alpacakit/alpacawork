import { test, beforeAll, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import { DiagnosticsDialog } from "../src/features/panels/DiagnosticsDialog";
import { WorkspaceNotice } from "../src/features/chrome/WorkspaceNotice";
import { WorkspaceFolderLine } from "../src/features/panels/WorkspaceFolderLine";
import { useConnection } from "../src/data/connection";
import { useDialogStore } from "../src/state/dialog-store";
import { TestWorkspace, screenData, tree } from "./fixtures";

beforeAll(() => startI18n());
afterEach(cleanup);

test("diagnostics lists actual connection, root, write access, every error, stale IDs and launch profiles", () => {
  const data = screenData(tree({ root: "/real/tasks", writable: false,
    errors: [{ path: "tasks/T8", code: "invalid_yaml", message: "Invalid document" }, { path: "tasks/T9", code: "denied", message: "Permission denied" }] }));
  data.info.staleIds = ["T8", "T9"];
  const reconnect = vi.fn();
  useConnection.setState({ state: "reconnecting", offline: true, message: () => "Retry in one second", reconnect });
  render(<TestWorkspace data={data}><DiagnosticsDialog /></TestWorkspace>);
  for (const text of ["Reconnecting", "Retry in one second", "/real/tasks", "tasks/T8", "tasks/T9", "T8", "T9", "claude, codex", "2 shown"]) expect(screen.getByText(text)).toBeTruthy();
  expect(screen.getAllByText("No")).toHaveLength(1);
  expect(screen.queryByText(/sample|mock|example/i)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" })); expect(reconnect).toHaveBeenCalledOnce();
});

test("read-only warning opens diagnostics and the server settings show the actual root with the way to diagnostics", async () => {
  useConnection.setState({ offline: false });
  const data = screenData(tree({ root: "/actual/root", writable: false }));
  const view = render(<TestWorkspace data={data}><WorkspaceNotice /></TestWorkspace>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("chrome:notice.diagnostics") }));
  expect(useDialogStore.getState().dialog?.kind).toBe("diagnostics");
  view.unmount();
  useDialogStore.setState({ dialog: null });
  render(<TestWorkspace data={data}><WorkspaceFolderLine /></TestWorkspace>);
  expect(screen.getAllByText("/actual/root")).toHaveLength(1);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("panels:settings.server.folderCopy") }));
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("/actual/root"));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("panels:settings.server.diagnostics") }));
  expect(useDialogStore.getState().dialog?.kind).toBe("diagnostics");
});
