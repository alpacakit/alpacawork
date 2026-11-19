import { allowFixtureWrites } from './read-fixtures';
import { test, expect, afterEach, beforeAll, vi } from "vitest";
import { act, render, screen, cleanup } from "@testing-library/react";
import {
  QueryClientProvider,
  useMutation,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { z } from "zod";
import { i18n, startI18n } from "@alpacawork/i18n";
import { Toaster } from "../src/components/ui/toaster";
import { ApiError, createApi, retryOf } from "../src/data/client";
import { useConnection } from "../src/data/connection";
import { queryClient } from "../src/data/query-client";
import { notify, useToasts } from "../src/lib/notify";

/**
 * How a failed request is read (retryOf) and the shared toast every failed
 * mutation raises through the one queryClient, unless it opts out with
 * `meta: { errorToast: false }`.
 */

beforeAll(() => startI18n());

afterEach(async () => {
  cleanup();
  for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id);
  queryClient.clear();
  useConnection.setState(useConnection.getInitialState(), true);
  await i18n.changeLanguage("en");
});

test.each([
  ["a changed task", new ApiError("Task changed", "conflict", "reread"), "reread"],
  ["a busy root", new ApiError("Root is in use", "busy", "later"), "later"],
  ["a save the server could not verify", new ApiError("Files changed after saving", "save_unconfirmed", "check"), "check"],
  ["an answer this app cannot read", new ApiError("Unexpected format", "invalid_response"), "check"],
  ["no answer", new ApiError("Cannot reach the server."), "check"],
  ["a refused input", new ApiError("Bad title", "invalid_input", "fix"), "fix"],
  ["a plain Error", new Error("boom"), "fix"],
  ["a thrown string", "boom", "fix"],
] as const)("retryOf reads %s as %s", (_name, error, retry) => {
  expect(retryOf(error)).toBe(retry);
});


function Failing(props: {
  error: unknown;
  meta?: UseMutationOptions["meta"];
}) {
  const mutation = useMutation({
    mutationFn: () => Promise.reject(props.error),
    meta: props.meta,
  });
  return (
    <button type="button" onClick={() => mutation.mutate()}>
      Run
    </button>
  );
}

async function run(error: unknown, meta?: UseMutationOptions["meta"]) {
  // These cases exercise server failures after admission. Closed-gate refusal has its own command tests.
  allowFixtureWrites();
  render(
    <QueryClientProvider client={queryClient}>
      <Failing error={error} meta={meta} />
      <Toaster />
    </QueryClientProvider>,
  );
  await act(async () => {
    screen.getByRole("button", { name: "Run" }).click();
  });
}

test.each([
  ['ja', 'task_changed', 'タスクが変更されました。再読み込みしてからやり直してください'],
  ['en', 'settings_changed', 'Settings changed. Reload and try again'],
] as const)('a %s mutation toast retains the translated %s reason and reload/retry action', async (language, kind, expected) => {
  await i18n.changeLanguage(language);
  await run(new ApiError('UNTRANSLATED DIAGNOSTIC', 'conflict', 'reread', undefined, [], { kind }));
  expect(await screen.findByText(expected)).toBeTruthy();
  expect(screen.queryByText('UNTRANSLATED DIAGNOSTIC')).toBeNull();
});

test("the toast's guidance and error follow the running language", async () => {
  await i18n.changeLanguage("ja");
  await run(new ApiError("Cannot reach the server."));
  expect(screen.getByRole("region", { name: "通知" })).toBeTruthy();
  expect(await screen.findByText("保存結果を確認してください。")).toBeTruthy();
  expect(screen.queryByText("Cannot reach the server.")).toBeNull();
});

test("meta.errorToast false keeps the shared toast silent", async () => {
  const error = vi.spyOn(notify, "failure");
  await run(new ApiError("Task changed", "conflict", "reread"), {
    errorToast: false,
  });
  await vi.waitFor(() =>
    expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe(
      "error",
    ),
  );
  expect(error).not.toHaveBeenCalled();
  expect(useToasts.getState().toasts).toEqual([]);
});
