import { expect, onTestFinished, test, vi } from "vitest";
import { glide, scrollReport } from "../src/features/reader/scroll-report";

// A jump's goal can move while it glides (on a phone, the reading header leaves as the column scrolls down, and the
// row's scroll-margin shrinks with it). The glide must bend toward the new goal and stop on it, never end on the old
// goal and jump the rest in one frame.
test("a goal that moves mid-glide is reached without a jump at the end", () => {
  const frame = 1000 / 60;
  const path = glide(0, 300, 0);
  const tops: number[] = [];
  let over = false;
  for (let n = 1; n < 120 && !over; n++) {
    const goal = n < 8 ? 300 : 357;
    const next = path.at(goal, n * frame);
    tops.push(next.at);
    over = next.over;
  }
  expect(over).toBe(true);
  expect(tops.at(-1)).toBe(357);
  const steps = tops.slice(1).map((top, n) => top - tops[n]!);
  // Never back, never past the goal, and the speed changes gradually, the last steps included.
  expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...tops)).toBeLessThanOrEqual(357.5);
  const changes = steps.slice(1).map((step, n) => Math.abs(step - steps[n]!));
  expect(Math.max(...changes)).toBeLessThan(20);
  expect(Math.max(...steps.slice(-3))).toBeLessThan(4);
});

// Between the call and the glide's first frame, rows can arrive above and the column be kept in place (scrollTop and the
// row move down together). The glide sets out from there: its first frame moves the column a little, not by that shift.
test("a column kept in place before the first frame does not jump at the start", () => {
  const frames: FrameRequestCallback[] = [];
  const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => frames.push(callback));
  onTestFinished(() => { frame.mockRestore(); document.body.replaceChildren(); });
  const area = document.createElement("div");
  area.setAttribute("data-reader-content", "");
  const target = document.createElement("div");
  area.append(target);
  document.body.append(area);
  Object.defineProperties(area, { scrollHeight: { value: 5000 }, clientHeight: { value: 800 } });
  let rowTop = 300;
  target.getBoundingClientRect = () => new DOMRect(0, rowTop - area.scrollTop, 100, 40);
  scrollReport(target, "start");
  rowTop += 40;
  area.scrollTop = 40;
  frames.shift()!(1000);
  expect(area.scrollTop).toBeLessThan(45);
  for (let n = 1; frames.length && n < 200; n++) frames.shift()!(1000 + n * 1000 / 60);
  expect(area.scrollTop).toBe(340);
});
