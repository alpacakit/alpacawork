import { expect, test } from "vitest";
import { pressOpensRow } from "../src/features/tree/row-press";

test("a press opens a list row's task on its title and its other words, not on its own controls or outside it", () => {
  document.body.innerHTML = `<div data-row-label><button data-read><span id="title">T1</span></button>
    <span id="speed"><svg><rect id="bar"/></svg></span><button id="time">2h</button></div><p id="away">x</p>`;
  const at = (id: string) => document.getElementById(id)!;
  expect([at("title"), at("speed"), at("bar")].map(pressOpensRow)).toEqual([true, true, true]);
  expect([at("time"), at("away")].map(pressOpensRow)).toEqual([false, false]);
});
