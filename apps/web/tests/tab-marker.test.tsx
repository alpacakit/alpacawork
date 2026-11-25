import { afterEach, expect, test } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TabMarker } from "../src/components/ui/tabs";

const original = globalThis.ResizeObserver;
afterEach(() => { globalThis.ResizeObserver = original; });

test("the chosen tab's ground follows the tab when it only grows taller (a phone's larger tabs)", async () => {
  let resized: (() => void) | null = null;
  globalThis.ResizeObserver = class { constructor(done: () => void) { resized = done; } observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<div><TabMarker current='[aria-current="true"]' /><button type="button" aria-current="true">a</button></div>));
  const tab = host.querySelector("button")!, marker = host.querySelector<HTMLElement>("[data-tab-marker]")!;
  const size = (height: number) => { for (const [key, value] of [["offsetWidth", 60], ["offsetHeight", height], ["offsetLeft", 0], ["offsetTop", 0]] as const)
    Object.defineProperty(tab, key, { configurable: true, value }); };
  size(28);
  await act(async () => resized!());
  expect(marker.style.height).toBe("28px");
  size(40);
  await act(async () => resized!());
  expect(marker.style.height).toBe("40px");
  await act(async () => root.unmount());
  host.remove();
});
