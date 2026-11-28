import { expect, test } from "vitest";
import { arrivalShifts } from "../src/lib/motion";

const item = (name: string) => ({ name, contains: () => false });

test("a row arriving under rows that close up comes in with them, not against them; with nothing moving above it, it settles from a little above", () => {
  // The first row left: the rows under it glide up by a row's height, and the row shown from under the list's foot arrives.
  const [head, second, last, arriving, more] = ["head", "second", "last", "arriving", "more"].map(item);
  const glides = new Map([[second!, 33], [last!, 33]]);
  expect(arrivalShifts([head!, second!, last!, arriving!, more!], [arriving!], glides, 6).get(arriving!)).toBe(33);
  // Two arriving together come in as one.
  const [top, first, next] = ["top", "first", "next"].map(item);
  const shifts = arrivalShifts([top!, first!, next!], [first!, next!], new Map(), 6);
  expect([shifts.get(first!), shifts.get(next!)]).toEqual([-6, -6]);
});
