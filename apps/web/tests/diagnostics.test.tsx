import { test, beforeAll, beforeEach, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import { DiagnosticsDialog } from "../src/features/panels/DiagnosticsDialog";
import { useConnection } from "../src/data/connection";
import { queryClient } from "../src/data/query-client";
import { useDialogStore } from "../src/state/dialog-store";
import { TestWorkspace, screenData, tree, run, dto } from "./fixtures";

/** Runs as the notices and diagnostics read them from the workspace's control tree. */
beforeAll(() => startI18n());
beforeEach(() => {
  useDialogStore.setState({ dialog: null });
  useConnection.setState({ offline: false });
});
afterEach(async () => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); await i18n.changeLanguage("en"); });

test("diagnostics shows the launch profiles, warns when there are none, and lists runs whose task is missing (a shelved task is not missing)", async () => {
  await i18n.changeLanguage("en");
  const data = screenData(tree({ tasks: [dto(), dto({ id: "T2", lifecycle: "archived" })],
    runs: [run("R12", { taskId: "T9" }), run(), run("R13", { taskId: "T2" })] }));
  const view = render(<TestWorkspace data={data}><DiagnosticsDialog /></TestWorkspace>);
  expect(screen.getByText("claude, codex")).toBeTruthy();
  expect(screen.getByText("R12 (T9)")).toBeTruthy(); expect(screen.queryByText("R1 (T1)")).toBeNull(); expect(screen.queryByText("R13 (T2)")).toBeNull();
  view.unmount();
  render(<TestWorkspace data={screenData(tree({ profiles: [] }))}><DiagnosticsDialog /></TestWorkspace>);
  expect(screen.getByText("No launch profiles").className).toBe("text-warn");
});

test("diagnostics does not count retained unreadable tasks as present in the tree", () => {
  const data = screenData(tree({ runs: [run()] })); data.info.staleIds = ["T1"];
  render(<TestWorkspace data={data}><DiagnosticsDialog /></TestWorkspace>);
  expect(screen.getByText("R1 (T1)")).toBeTruthy();
});
