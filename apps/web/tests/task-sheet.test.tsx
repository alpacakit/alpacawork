import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useScreenHeight, useSheetMotion, type SheetControl } from "../src/features/reader/TaskSheet";
import { FIRST_SHARE, sheetShare, setSheetShare } from "../src/state/sheets";

/** The phone's task sheet: how it rests once a finger lets go. */
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

let control: SheetControl;
function Moving() {
  const [whole, onWhole] = useState(false);
  control = useSheetMotion({ whole, onWhole, onAway() {}, rising: false });
  return <div ref={control.frame}><div {...control.grip} data-test-grip /></div>;
}
/** A mouse pressed on the sheet's grip, as the browser sends it: the sheet hears it (TaskSheet `begin`). */
const pressGrip = (frame: HTMLElement, y: number, time: number) => {
  const grip = frame.querySelector<HTMLElement>("[data-test-grip]")!;
  grip.dispatchEvent(pointer("pointerdown", y, time));
};
const pointer = (type: string, y: number, time: number) => {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerId: 1, clientX: 0, clientY: y, isPrimary: true, button: 0, pointerType: "mouse" });
  Object.defineProperty(event, "timeStamp", { value: time });
  return event;
};

test("let go at the height it already stands at, a sheet rests as tall as it stands, not as tall as the screen", async () => {
  vi.stubGlobal("innerHeight", 915);
  setSheetShare(0.85);
  render(<Moving />);
  const frame = control.frame.current!;
  frame.getAnimations = () => [];
  vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => ({ top: 915 - Number.parseFloat(frame.style.height) }) as DOMRect);
  expect(frame.style.height).toBe("778px");
  await act(async () => {
    pressGrip(frame, 100, 100);
    frame.dispatchEvent(pointer("pointermove", 90, 300));
    frame.dispatchEvent(pointer("pointerup", 90, 500));
    await Promise.resolve();
  });
  expect(sheetShare.get()).toBe(0.85);
  expect(frame.dataset.sheetHeld).toBeUndefined();
  expect(frame.style.height).toBe("778px");
  expect(frame.style.transform).toBe("");
});

test("a press let go over what it opened (a menu over the header) ends there: a later move of the pointer leaves the sheet where it stands", async () => {
  vi.stubGlobal("innerHeight", 844);
  setSheetShare(2 / 3);
  render(<Moving />);
  const frame = control.frame.current!;
  frame.getAnimations = () => [];
  const menu = document.createElement("div"); document.body.append(menu);
  await act(async () => {
    pressGrip(frame, 300, 100);
    menu.dispatchEvent(pointer("pointerup", 300, 150));
    frame.dispatchEvent(pointer("pointermove", 100, 300));
    await Promise.resolve();
  });
  expect(frame.dataset.sheetHeld).toBeUndefined();
  expect(frame.style.transform).toBe("");
  expect(frame.style.height).toBe("563px");
  menu.remove();
});

test("a sheet gone while it is held (Back meanwhile) ends the press: a later move or let go does nothing", () => {
  vi.stubGlobal("innerHeight", 844);
  const view = render(<Moving />);
  const frame = control.frame.current!;
  act(() => pressGrip(frame, 300, 100));
  view.unmount();
  const errors: string[] = [];
  const collect = (event: ErrorEvent) => { errors.push(event.message); event.preventDefault(); };
  addEventListener("error", collect);
  try {
    window.dispatchEvent(pointer("pointermove", 200, 200));
    window.dispatchEvent(pointer("pointerup", 200, 300));
  } finally { removeEventListener("error", collect); }
  expect(errors).toEqual([]);
});

test("the hand's destination is stored before motion ends; a resize during settlement only fits the display", async () => {
  vi.stubGlobal("innerHeight", 915); setSheetShare(2 / 3);
  render(<Moving />);
  const frame = control.frame.current!; frame.getAnimations = () => [];
  vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => ({ top: 915 - Number.parseFloat(frame.style.height) }) as DOMRect);
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  vi.spyOn(frame, "animate").mockReturnValue({ finished, cancel() {} } as unknown as Animation);
  act(() => {
    pressGrip(frame, 100, 100);
    window.dispatchEvent(pointer("pointermove", 250, 300));
    window.dispatchEvent(pointer("pointerup", 250, 500));
  });
  const saved = 460 / 915;
  expect(sheetShare.get()).toBe(saved);
  expect(localStorage.getItem("alpacawork.sheetHeight")).toBe(String(saved));
  act(() => { vi.stubGlobal("innerHeight", 650); window.dispatchEvent(new Event("resize")); });
  await act(async () => { finish(); await finished; });
  expect(frame.style.height).toBe(`${Math.round(saved * 650)}px`);
  expect(sheetShare.get()).toBe(saved);
});

test("a cancelled drag restores the stored destination without overwriting it", async () => {
  vi.stubGlobal("innerHeight", 915); setSheetShare(0.5); render(<Moving />);
  const frame = control.frame.current!; frame.getAnimations = () => [];
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ top: 457 } as DOMRect);
  await act(async () => {
    pressGrip(frame, 100, 100);
    window.dispatchEvent(pointer("pointermove", 250, 300));
    window.dispatchEvent(pointer("pointercancel", 250, 500));
    await Promise.resolve();
  });
  expect(sheetShare.get()).toBe(0.5); expect(frame.style.height).toBe("458px");
});

const keptRaw = (raw: string | null) => {
  if (raw === null) localStorage.removeItem("alpacawork.sheetHeight"); else localStorage.setItem("alpacawork.sheetHeight", raw);
  window.dispatchEvent(new Event("pageshow"));
};

test.each(["broken", "5"])("a kept height of %s stands at the first share and is not written over", (raw) => {
  keptRaw(raw);
  expect(sheetShare.get()).toBe(FIRST_SHARE);
  expect(localStorage.getItem("alpacawork.sheetHeight")).toBe(raw);
  keptRaw(null);
});

test("the whole screen and back again never replace what is kept, even an unreadable height", async () => {
  vi.stubGlobal("innerHeight", 915); keptRaw("broken"); render(<Moving />);
  const frame = control.frame.current!; frame.getAnimations = () => [];
  vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => ({ top: 915 - Number.parseFloat(frame.style.height) }) as DOMRect);
  vi.spyOn(frame, "animate").mockImplementation(() => ({ finished: Promise.resolve(), cancel() {} }) as unknown as Animation);
  await act(async () => { control.toggleWhole(); await Promise.resolve(); });
  expect(frame.style.height).toBe("915px");
  await act(async () => { control.toggleWhole(); await Promise.resolve(); });
  expect(frame.style.height).toBe("610px");
  expect(localStorage.getItem("alpacawork.sheetHeight")).toBe("broken");
  keptRaw(null);
});

/** A grip whose header opened something drawn elsewhere (a menu in a portal): the sheet only hears its own DOM. */
function MovingWithMenu() {
  const [whole, onWhole] = useState(false);
  control = useSheetMotion({ whole, onWhole, onAway() {}, rising: false });
  return <div ref={control.frame}><div {...control.grip} data-test-grip>{createPortal(<div data-test-menu />, document.body)}</div></div>;
}

test("a press in what the header opened elsewhere (a portal) does not move the sheet: only the sheet's own grip does", () => {
  vi.stubGlobal("innerHeight", 915); setSheetShare(0.5);
  render(<MovingWithMenu />);
  const frame = control.frame.current!; frame.getAnimations = () => [];
  const menu = document.querySelector<HTMLElement>("[data-test-menu]")!;
  act(() => {
    menu.dispatchEvent(pointer("pointerdown", 100, 100));
    window.dispatchEvent(pointer("pointermove", 300, 200));
  });
  expect(frame.dataset.sheetHeld).toBeUndefined();
  expect(frame.style.transform).toBe("");
  act(() => { window.dispatchEvent(pointer("pointerup", 300, 300)); });
  act(() => {
    pressGrip(frame, 100, 400);
    window.dispatchEvent(pointer("pointermove", 300, 500));
  });
  expect(frame.dataset.sheetHeld).toBe("");
  act(() => { window.dispatchEvent(pointer("pointerup", 300, 600)); });
});

function Heights({ children }: { children?: ReactNode }) {
  const first = useScreenHeight(), second = useScreenHeight();
  return <><output>{first}/{second}</output>{children}</>;
}

test("a parent commit does not read window height again", () => {
  const height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
  const view = render(<Heights />); height.mockClear();
  view.rerender(<Heights><span>parent state changed</span></Heights>);
  expect(height).not.toHaveBeenCalled();
  expect(view.getByRole("status").textContent).toBe("900/900");
});

test("a resize before subscribing, later resizes, and a fresh mount reach every height reader", () => {
  const height = vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
  function BeforeSubscription() {
    useLayoutEffect(() => { height.mockReturnValue(700); window.dispatchEvent(new Event("resize")); }, []);
    return null;
  }
  const view = render(<Heights><BeforeSubscription /></Heights>);
  expect(view.getByRole("status").textContent).toBe("700/700");
  act(() => { height.mockReturnValue(650); window.dispatchEvent(new Event("resize")); });
  expect(view.getByRole("status").textContent).toBe("650/650");
  view.unmount(); height.mockReturnValue(500);
  const fresh = render(<Heights />);
  expect(fresh.getByRole("status").textContent).toBe("500/500");
});
