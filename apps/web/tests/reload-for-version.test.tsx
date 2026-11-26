import { afterEach, expect, test, vi } from "vitest";
import { reloadForVersion } from "@/features/update/update-state";

afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

test("a page is reloaded for a new version at most once a minute for the same version, but at once for another", () => {
  const reload = vi.fn();
  expect(reloadForVersion("0.1.8", reload)).toBe(true);
  expect(reloadForVersion("0.1.8", reload)).toBe(false);
  expect(reloadForVersion("0.1.9", reload)).toBe(true);
  expect(reload).toHaveBeenCalledTimes(2);
});
