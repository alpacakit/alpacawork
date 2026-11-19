import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen as viewScreen } from "@testing-library/react";
import { useRef } from "react";
import { dropWaiting, onTheWay, pointerOn, useHoverCardTarget, waitOnTheWay } from "../src/components/ui/hover-card";

afterEach(() => { cleanup(); pointerOn(null); });
function Card() {
  const ref = useRef<HTMLDivElement>(null);
  useHoverCardTarget(ref);
  return <div ref={ref} data-testid="card" style={{ visibility: 'hidden' }} />;
}

test("on a card's edge the pointer is still on its way to it, not asking from inside it", () => {
  render(<Card />);
  const card = viewScreen.getByTestId("card");
  card.style.visibility = "visible";
  card.getBoundingClientRect = () => new DOMRect(400, 200, 400, 300);
  pointerOn({ x: 900, y: 350 });
  // The row's line beside the card asks at the card's right edge: that waits.
  expect(waitOnTheWay({ x: 800, y: 350 }, () => {})).toBe(true);
  // A task named inside the card asks from within it: that opens at once.
  expect(waitOnTheWay({ x: 700, y: 350 }, () => {})).toBe(false);
  dropWaiting();
});

test("the way to a card is the shape between where the pointer left and the card; a card over where it left has none to keep", () => {
  render(<Card />);
  const card = viewScreen.getByTestId("card");
  card.getBoundingClientRect = () => new DOMRect(400, 200, 400, 300);
  pointerOn({ x: 300, y: 150 });
  // Not laid out yet: nowhere to go.
  expect(onTheWay({ x: 350, y: 180 })).toBe(false);
  card.style.visibility = "visible";
  expect(onTheWay({ x: 350, y: 180 })).toBe(true);
  expect(onTheWay({ x: 500, y: 300 })).toBe(true);
  expect(onTheWay({ x: 300, y: 190 })).toBe(false);
  expect(onTheWay({ x: 250, y: 150 })).toBe(false);
  pointerOn({ x: 500, y: 250 });
  expect(onTheWay({ x: 300, y: 250 })).toBe(false);
  pointerOn(null);
  expect(onTheWay({ x: 350, y: 180 })).toBe(false);
});
