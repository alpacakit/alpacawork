import { expect, test } from "vitest";
import { pullsFrom } from "../src/lib/sheet-press";

/** A sheet, a thread in it, and a message in the thread, every part panning by finger. */
function sheet() {
  document.body.innerHTML = `<div id="sheet" style="touch-action: auto"><ol id="thread" style="touch-action: auto"><li id="row" style="touch-action: auto">words</li></ol></div>`;
  return { sheet: document.getElementById("sheet")!, thread: document.getElementById("thread")!, row: document.getElementById("row")! };
}
const touch = { pointerType: "touch" } as PointerEvent;

test("a finger at the top of what a sheet shows pulls it, but not while that part is still reading in what comes above it", () => {
  const { sheet: surface, thread, row } = sheet();
  expect(pullsFrom(touch, row, surface)).toBe(true);
  // Something only being read (a task's history, a placeholder) is no reason to hold the sheet.
  thread.setAttribute("aria-busy", "true");
  expect(pullsFrom(touch, row, surface)).toBe(true);
  thread.setAttribute("data-reading-above", "");
  expect(pullsFrom(touch, row, surface)).toBe(false);
});
