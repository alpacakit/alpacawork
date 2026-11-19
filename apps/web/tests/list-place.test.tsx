import { expect, test } from "vitest";
import { listPlace } from "../src/data/queries";
import type { WorkspaceInfo } from "../src/data/types";

const info = (projects: { id: string }[]) => ({ projects, counts: { tasks: { root: 1 } } }) as unknown as WorkspaceInfo;

test("before the first index the list's place is loading, not the no-project page", () => {
  expect(listPlace(false, null, null)).toBe("loading");
  expect(listPlace(false, "P1", null)).toBe("loading");
  expect(listPlace(false, null, info([]))).toBe("no-projects");
  expect(listPlace(false, null, info([{ id: "P1" }]))).toBe("list");
});
