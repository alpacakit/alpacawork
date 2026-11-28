import { expect, test } from "vitest";
import { arrivalShifts } from "../src/lib/motion";

const items = (...names: string[]) => names.map(name => ({ name, contains: () => false }));

test("rows arriving under rows that close up come in with them, not against them; with nothing moving above, they settle from a little above", () => {
  // The first row left: the rows under it glide up by a row's height, and the rows shown from under the list's foot arrive.
  const [head, second, last, arriving, next, more] = items("head", "second", "last", "arriving", "next", "more");
  const closing = arrivalShifts([head!, second!, last!, arriving!, next!, more!], [arriving!, next!], new Map([[second!, 33], [last!, 33]]), 6);
  expect([closing.get(arriving!), closing.get(next!)]).toEqual([33, 33]);
  const [top, first, after] = items("top", "first", "after");
  const still = arrivalShifts([top!, first!, after!], [first!, after!], new Map(), 6);
  expect([still.get(first!), still.get(after!)]).toEqual([-6, -6]);
});
