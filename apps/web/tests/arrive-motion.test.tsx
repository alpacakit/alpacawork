import { afterEach, expect, test, vi } from "vitest";
import { arrive } from "../src/lib/motion";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

const arrivedFrom = (reduced: boolean) => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
  const element = document.createElement("div");
  document.body.append(element);
  const animate = vi.fn();
  element.animate = animate as unknown as typeof element.animate;
  arrive(element);
  return animate.mock.calls[0]![0] as Keyframe[];
};

test("a mark that just happened grows from its point, and under reduced motion it only fades in", () => {
  expect(arrivedFrom(false)[0]!.scale).toBeLessThan(1);
  expect(arrivedFrom(true)[0]!.scale).toBe(1);
  expect(arrivedFrom(true)[0]!.opacity).toBe(0);
});
