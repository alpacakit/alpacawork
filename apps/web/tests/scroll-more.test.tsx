import { renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useScrollMore } from "../src/lib/scroll-more";

test("scroll edges are available before the first size notification", () => {
  // Contract inputs, not a jsdom layout measurement: the size observer has not delivered anything yet.
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const box = document.createElement("div");
  Object.defineProperties(box, { scrollWidth: { value: 240 }, clientWidth: { value: 120 } });
  const hook = renderHook(() => useScrollMore(box));
  try { expect(hook.result.current).toBe("end"); }
  finally { hook.unmount(); vi.unstubAllGlobals(); }
});
