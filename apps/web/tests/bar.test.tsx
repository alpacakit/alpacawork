import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { UNDER_BAR, useBar, useBarAutoHide } from "../src/state/bar";
import { READING_THRESHOLD as BAR_THRESHOLD } from "../src/lib/reading-scroll";

/**
 * The bar over the list: on a phone, reading a list under the bar down hides it, any move up past the threshold
 * shows it, the top always shows it; other scrollers leave it; a pin shows it and gives back the state it had.
 */
const BAR = 60;
beforeEach(() => useBar.setState({ hidden: false, height: BAR }));
afterEach(cleanup);

function Page({ enabled = true, pinned = false, open = false }: { enabled?: boolean; pinned?: boolean; open?: boolean }) {
  useBarAutoHide(enabled, pinned);
  return <>
    <div data-bar=""><button type="button" aria-expanded={open}>menu</button></div>
    <div data-testid="list" {...UNDER_BAR} />
    <div data-testid="sheet" />
  </>;
}
/** Scrolls an element to `top` as the browser would: its position, then the scroll event. */
function scrollTo(element: HTMLElement, top: number, height = 800) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: height });
  Object.defineProperty(element, "scrollTop", { configurable: true, value: top });
  act(() => { element.dispatchEvent(new Event("scroll")); });
}
const hidden = () => useBar.getState().hidden;

test("reading down past the threshold hides the bar; a tremble does not bring it back, a move up does", () => {
  const { getByTestId } = render(<Page />);
  const list = getByTestId("list");
  scrollTo(list, 200);
  scrollTo(list, 200 + BAR_THRESHOLD);
  expect(hidden()).toBe(false);
  scrollTo(list, 200 + BAR_THRESHOLD + 1);
  expect(hidden()).toBe(true);
  // Stopping keeps it hidden; small moves either way do not show it.
  scrollTo(list, 210);
  scrollTo(list, 220);
  scrollTo(list, 210);
  expect(hidden()).toBe(true);
  scrollTo(list, 210 - BAR_THRESHOLD - 1);
  expect(hidden()).toBe(false);
});

test("within the bar's height of the top the bar is shown, whichever way the list went", () => {
  const { getByTestId } = render(<Page />);
  const list = getByTestId("list");
  scrollTo(list, 100);
  scrollTo(list, 300);
  expect(hidden()).toBe(true);
  scrollTo(list, BAR);
  expect(hidden()).toBe(false);
  // From the top, a run down hides it only once past the bar's height.
  scrollTo(list, 0);
  scrollTo(list, BAR);
  expect(hidden()).toBe(false);
});

test("a bounce past the list's end is not a move up", () => {
  const { getByTestId } = render(<Page />);
  const list = getByTestId("list");
  scrollTo(list, 900);
  scrollTo(list, 1200);
  expect(hidden()).toBe(true);
  scrollTo(list, 1260);
  scrollTo(list, 1200);
  expect(hidden()).toBe(true);
});

test("resizing the list's viewport preserves the bar and starts a fresh reading baseline", () => {
  const { getByTestId } = render(<Page />);
  const list = getByTestId("list");
  scrollTo(list, 1200);
  // A bottom anchor follows a shorter viewport; growing it clamps back. Neither is a reading gesture.
  scrollTo(list, 1300, 700);
  scrollTo(list, 1200, 800);
  expect(hidden()).toBe(false);
  scrollTo(list, 1190, 780);
  scrollTo(list, 1190 + BAR_THRESHOLD + 1, 780);
  expect(hidden()).toBe(true);
  scrollTo(list, 1200, 800);
  expect(hidden()).toBe(true);
  scrollTo(list, 1200 - BAR_THRESHOLD, 800);
  expect(hidden()).toBe(true);
  scrollTo(list, 1200 - BAR_THRESHOLD - 1, 800);
  expect(hidden()).toBe(false);
});

test("a list that got shorter and was clamped to its top shows the bar, though no one read up", () => {
  const { getByTestId } = render(<Page />);
  const list = getByTestId("list");
  scrollTo(list, 300);
  scrollTo(list, 300 + BAR_THRESHOLD + 1);
  expect(hidden()).toBe(true);
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 800 });
  Object.defineProperty(list, "scrollTop", { configurable: true, value: 0 });
  act(() => { list.dispatchEvent(new Event("scroll")); });
  expect(hidden()).toBe(false);
});

test("the first reading gesture after a resize without scrolling still counts", () => {
  let reportSize: ResizeObserverCallback;
  const observer = { observe() {}, unobserve() {}, disconnect() {} } as ResizeObserver;
  const resized = vi.spyOn(globalThis, "ResizeObserver").mockImplementation(function (callback) { reportSize = callback; return observer; });
  onTestFinished(() => resized.mockRestore());
  const { getByTestId } = render(<Page />);
  const list = getByTestId("list");
  scrollTo(list, 170);
  Object.defineProperty(list, "clientHeight", { configurable: true, value: 900 });
  act(() => reportSize([{ target: list, contentRect: list.getBoundingClientRect(),
    borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], observer));
  scrollTo(list, 270, 900);
  expect(hidden()).toBe(true);
});

test("the first reading gesture after the room at the list's foot changed (its content, not its viewport) still counts", () => {
  let reportSize: ResizeObserverCallback;
  const observer = { observe() {}, unobserve() {}, disconnect() {} } as ResizeObserver;
  const resized = vi.spyOn(globalThis, "ResizeObserver").mockImplementation(function (callback) { reportSize = callback; return observer; });
  onTestFinished(() => resized.mockRestore());
  const { getByTestId } = render(<Page />);
  const list = getByTestId("list");
  scrollTo(list, 170);
  // The coordinator's input came up: the list keeps more room inside its end, its viewport the same.
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 2200 });
  act(() => reportSize([{ target: list, contentRect: list.getBoundingClientRect(),
    borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], observer));
  Object.defineProperty(list, "scrollTop", { configurable: true, value: 270 });
  act(() => { list.dispatchEvent(new Event("scroll")); });
  expect(hidden()).toBe(true);
});

test("scrolling anything not under the bar leaves it as it is", () => {
  const { getByTestId } = render(<Page />);
  scrollTo(getByTestId("sheet"), 100);
  scrollTo(getByTestId("sheet"), 500);
  expect(hidden()).toBe(false);
});

test("a control of the bar with something open keeps it from hiding", () => {
  const { getByTestId } = render(<Page open />);
  const list = getByTestId("list");
  scrollTo(list, 100);
  scrollTo(list, 400);
  expect(hidden()).toBe(false);
});

test("a pin shows the bar and, when it goes, gives back the state it had", () => {
  const { getByTestId, rerender } = render(<Page />);
  const list = getByTestId("list");
  scrollTo(list, 100);
  scrollTo(list, 400);
  expect(hidden()).toBe(true);
  rerender(<Page pinned />);
  expect(hidden()).toBe(false);
  scrollTo(list, 800);
  expect(hidden()).toBe(false);
  rerender(<Page />);
  expect(hidden()).toBe(true);
});

test("where it is not enabled (a computer) the bar never hides", () => {
  const { getByTestId } = render(<Page enabled={false} />);
  const list = getByTestId("list");
  scrollTo(list, 100);
  scrollTo(list, 400);
  expect(hidden()).toBe(false);
});
