import { afterEach, expect, test } from "vitest";
import { guardPinchZoom } from "../src/lib/pinch-zoom";

const viewport = Object.assign(new EventTarget(), { scale: 1 });
Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
const zoom = (scale: number) => { viewport.scale = scale; viewport.dispatchEvent(new Event("resize")); };

let unguard = () => {};
afterEach(() => { unguard(); zoom(1); document.body.replaceChildren(); });

/** Which of the events reach a listener on an element under the guard. */
function reaching(events: Event[]) {
  const area = document.body.appendChild(document.createElement("div"));
  const seen: string[] = [];
  for (const type of new Set(events.map(event => event.type))) area.addEventListener(type, (event) => seen.push(name(event)));
  for (const event of events) area.dispatchEvent(event);
  return seen;
}
const pointer = (type: string, pointerType: string) => Object.assign(new MouseEvent(type, { bubbles: true }), { pointerType });
const name = (event: Event) => "pointerType" in event ? `${event.type}:${event.pointerType as string}` : event.type;
const all = () => [
  new Event("touchstart", { bubbles: true }), new Event("touchmove", { bubbles: true }), new Event("touchend", { bubbles: true }),
  new Event("gesturestart", { bubbles: true }), new Event("gesturechange", { bubbles: true }), new Event("wheel", { bubbles: true }),
  pointer("pointerdown", "touch"), pointer("pointermove", "touch"), pointer("pointerup", "touch"), pointer("pointercancel", "touch"),
  pointer("pointermove", "mouse"), pointer("contextmenu", "touch"), pointer("contextmenu", "mouse"), new MouseEvent("click", { bubbles: true }),
];

test("pinch-zoomed, the app's gestures start nowhere, while presses, lifts, a mouse and a tap still arrive", () => {
  unguard = guardPinchZoom(window);
  zoom(2.5);
  expect(document.body.hasAttribute("data-pinch-zoomed")).toBe(true);
  expect(reaching(all())).toEqual(["touchend", "pointerdown:touch", "pointerup:touch", "pointercancel:touch",
    "pointermove:mouse", "contextmenu:mouse", "click"]);
});

test("back at normal scale the gestures are the app's again, and a lifted guard leaves nothing behind", () => {
  unguard = guardPinchZoom(window);
  zoom(2.5);
  zoom(1);
  expect(document.body.hasAttribute("data-pinch-zoomed")).toBe(false);
  expect(reaching(all())).toHaveLength(all().length);
  zoom(2.5);
  unguard();
  expect(document.body.hasAttribute("data-pinch-zoomed")).toBe(false);
  expect(reaching(all())).toHaveLength(all().length);
});

test("a zoom too slight to see is no zoom: the gestures stay the app's until the page is visibly zoomed", () => {
  unguard = guardPinchZoom(window);
  zoom(1.05);
  expect(document.body.hasAttribute("data-pinch-zoomed")).toBe(false);
  expect(reaching(all())).toHaveLength(all().length);
  zoom(1.2);
  expect(document.body.hasAttribute("data-pinch-zoomed")).toBe(true);
  expect(reaching(all())).not.toContain("pointermove:touch");
});
