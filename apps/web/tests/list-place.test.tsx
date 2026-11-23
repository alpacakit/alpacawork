import { expect, onTestFinished, test } from "vitest";
import { renderHook } from "@testing-library/react";
import { listPlace, useListPlace } from "../src/data/queries";
import { guideStages, restartGuide } from "../src/features/guide/guide-state";
import { TestWorkspace } from "./fixtures";
import type { WorkspaceInfo } from "../src/data/types";

const info = (projects: { id: string }[]) => ({ projects, counts: { tasks: { root: 1 } } }) as unknown as WorkspaceInfo;

test("before the first index the list's place is loading, not the no-project page", () => {
  expect(listPlace(false, null, null)).toBe("loading");
  expect(listPlace(false, "P1", null)).toBe("loading");
  expect(listPlace(false, null, info([]))).toBe("no-projects");
  expect(listPlace(false, null, info([{ id: "P1" }]))).toBe("list");
});

test("the guide shown again from settings leaves the list in place: the work in it, Done too, stays in view", () => {
  onTestFinished(() => { guideStages.computer.set(null); });
  restartGuide();
  const place = renderHook(() => useListPlace(), { wrapper: ({ children }) => <TestWorkspace>{children}</TestWorkspace> });
  expect(place.result.current).toBe("list");
});
