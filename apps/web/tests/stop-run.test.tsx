import { beforeEach as beforeSendCase } from 'vitest';
import { allowFixtureWrites } from './read-fixtures';
beforeSendCase(allowFixtureWrites);
import { test, beforeAll, beforeEach, afterEach, expect, vi } from "vitest";
import { act, render, renderHook, screen, cleanup, fireEvent } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import { DialogHost } from "../src/features/shell/DialogHost";
import { useDialogStore } from "../src/state/dialog-store";
import { useViewStore } from "../src/state/view-store";
import { useConnection } from "../src/data/connection";
import { queryClient } from "../src/data/query-client";
import { useStopRun } from "../src/data/queries";
import { indexKey } from "../src/data/resources";
import type { ProjectedIndexDTO } from "@alpacawork/contract/control";
import { TestWorkspace, screenData, tree, run } from "./fixtures";

/** The confirmation that stays modal when closing a run review. */
beforeAll(() => startI18n());
beforeEach(() => {
  useConnection.setState({ offline: false }); useDialogStore.setState({ dialog: null }); useViewStore.setState(useViewStore.getInitialState());
});
afterEach(async () => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); await i18n.changeLanguage("en"); });
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("stop settles with the server's answer; the stopped record arrives with the feed", async () => {
  const before = run("R1", { state: "running", endedAt: null });
  const data = screenData(tree({ runs: [before] }));
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ admitted: {}, cancelled: [], stop_requested: ["R1"] }));
  const hook = renderHook(() => useStopRun(), { wrapper: ({ children }) => <TestWorkspace data={data}>{children}</TestWorkspace> });
  await act(async () => { await hook.result.current.mutateAsync(before); });
  expect(fetch).toHaveBeenCalledOnce();
  expect(queryClient.getQueryData<ProjectedIndexDTO>(indexKey)!.runs).toEqual([before]);
});

test("a run review's close confirmation is the one modal dialog and closes with the store", () => {
  const value = screenData(tree({ runs: [run("R1", { state: "needs_review", endedAt: null })] }));
  useDialogStore.getState().openRun({ runId: "R1" });
  render(<TestWorkspace data={value}><DialogHost /></TestWorkspace>);
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByText("Close R1.")).toBeTruthy();
  fireEvent.click(button("Cancel"));
  expect(useDialogStore.getState().dialog).toBeNull();
});
