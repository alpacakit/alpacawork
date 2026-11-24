import { expect, onTestFinished, test } from "vitest";
import { renderHook } from "@testing-library/react";
import { listPlace, useListPlace } from "../src/data/queries";
import { guideStages, restartGuide } from "../src/features/guide/guide-state";
import { TestWorkspace } from "./fixtures";
import type { WorkspaceInfo } from "../src/data/types";

const info = (projects: { id: string }[], tasks = 1, review = 0) => ({ projects,
  counts: { tasks: { root: tasks }, home: { root: { doing: 0, error: 0, review, awaited: 0, held: 0, todo: 0 } } } }) as unknown as WorkspaceInfo;

test("before the first index the list's place is loading, not the no-project page", () => {
  expect(listPlace(false, null, null)).toBe("loading");
  expect(listPlace(false, "P1", null)).toBe("loading");
  expect(listPlace(false, null, info([]))).toBe("no-projects");
  expect(listPlace(false, null, info([{ id: "P1" }]))).toBe("list");
});

test("a project with no Tasks yet whose own row is listed (its responsible asks the user) shows the list, not the welcome", () => {
  expect(listPlace(false, null, info([{ id: "P1" }], 0))).toBe("welcome");
  expect(listPlace(false, null, info([{ id: "P1" }], 0, 1))).toBe("list");
});

test("the guide shown again from settings leaves the list in place: the work in it, Done too, stays in view", () => {
  onTestFinished(() => { guideStages.computer.set(null); });
  restartGuide();
  const place = renderHook(() => useListPlace(), { wrapper: ({ children }) => <TestWorkspace>{children}</TestWorkspace> });
  expect(place.result.current).toBe("list");
});
