import { beforeEach, expect, test } from "vitest";
import { setAutoSwipe, showCard, swipesOnSend, useSitting, type ReaderCard } from "../src/features/reader/next-question";
import { useViewStore } from "../src/state/view-store";

/** Auto-swipe is one value on this device, off until it is turned on, held from one press to the next whatever card is shown. */
const open = (taskId: string): ReaderCard => {
  useViewStore.setState(state => ({ selected: taskId, reader: { ...state.reader, open: true } }));
  const card = { taskId };
  showCard(card, "review", true, [[taskId, "turn"]]);
  return card;
};

beforeEach(() => {
  localStorage.clear();
  useViewStore.setState(state => ({ selected: null, reader: { ...state.reader, open: false } }));
  useSitting.setState({ card: null, order: [], departures: {}, sent: null, emptied: null });
});

test("nothing kept, a send from the input stays on its card; turned on, sends leave", () => {
  open("T1");
  expect(swipesOnSend()).toBe(false);
  setAutoSwipe(true);
  expect(swipesOnSend()).toBe(true);
  setAutoSwipe(false);
  expect(swipesOnSend()).toBe(false);
});

test("auto-swipe holds until it is pressed again: another card, leaving the detail and opening it again keep it", () => {
  open("T1");
  setAutoSwipe(true);
  open("T2");
  expect(swipesOnSend()).toBe(true);
  useViewStore.setState(state => ({ reader: { ...state.reader, open: false } }));
  expect(swipesOnSend()).toBe(true);
  open("T2");
  expect(swipesOnSend()).toBe(true);
  useViewStore.setState({ project: "P-other" });
  expect(swipesOnSend()).toBe(true);
});

test("auto-swipe is kept on this device, so a reload finds it as it was left", () => {
  setAutoSwipe(true);
  expect(localStorage.getItem("alpacawork.autoSwipe")).toBe("on");
  setAutoSwipe(false);
  expect(localStorage.getItem("alpacawork.autoSwipe")).toBe("off");
  localStorage.setItem("alpacawork.autoSwipe", "on");
  expect(swipesOnSend()).toBe(true);
  localStorage.setItem("alpacawork.autoSwipe", "unexpected");
  expect(swipesOnSend()).toBe(false);
});
