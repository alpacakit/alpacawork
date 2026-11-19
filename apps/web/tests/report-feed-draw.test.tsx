import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { ReportFeed } from "../src/features/reader/ReportFeed";
import { queryClient } from "../src/data/query-client";
import { indexKey } from "../src/data/resources";
import { dto, indexOf, screenData, TestWorkspace, tree } from "./fixtures";

// A deferred render that never ends, as under a stream of live updates that each begin it again: a value deferred from
// an initial one stays at that initial one.
vi.mock("react", async (actual) => {
  const react = await actual<typeof import("react")>();
  return { ...react, useDeferredValue: <T,>(value: T, initial?: T) => (initial === undefined ? value : initial) };
});

beforeAll(() => startI18n());
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

test("an opened feed shows the reports' placeholder, then its rows by the next frame even while its deferred render never ends", async () => {
  const value = tree({ tasks: [dto()] });
  const data = screenData(value);
  queryClient.setQueryData(indexKey, indexOf(value));
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(() => {}));
  render(<TestWorkspace data={{ ...data, seed: () => {} }}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelector('[data-report-feed] [data-skeleton="reports"]')).not.toBeNull();
  // The drawn feed says whether History is still being read; the placeholder it stood in for is gone.
  await waitFor(() => expect(document.querySelector("[data-report-feed][aria-busy]")).not.toBeNull());
  expect(document.querySelector('[data-skeleton="reports"]')).toBeNull();
});
