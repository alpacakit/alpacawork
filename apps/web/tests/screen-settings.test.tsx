import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { listColumns, readerListReservation, readerWidth, readSetting, SPEED_LANE, titleColumnWidth, writeSetting } from "../src/state/screen-settings";

beforeEach(() => { localStorage.clear(); history.replaceState(null, "", "/"); });
afterEach(() => vi.restoreAllMocks());

test("a valid URL setting wins over this device's value; missing keys use the device", () => {
  localStorage.setItem("alpacawork.screen.zoom", "604800000");
  localStorage.setItem("alpacawork.screen.strip", "on");
  expect(readSetting("zoom", new URL("http://localhost/?zoom=21600000"))).toBe("21600000");
  expect(readSetting("strip", new URL("http://localhost/?zoom=21600000"))).toBe("on");
  expect(readSetting("zoom", new URL("http://localhost/?zoom=broken"))).toBe("");
});

test("writes use the same URL key and device key, including explicit defaults", () => {
  writeSetting("strip", "on");
  expect(new URL(location.href).searchParams.get("strip")).toBe("on");
  expect(localStorage.getItem("alpacawork.screen.strip")).toBe("on");
  writeSetting("strip", "off");
  expect(new URL(location.href).searchParams.get("strip")).toBe("off");
  expect(localStorage.getItem("alpacawork.screen.strip")).toBe("off");
  localStorage.setItem("alpacawork.screen.strip", "on");
  expect(readSetting("strip")).toBe("off");
});

test("corrupt or unavailable device storage falls back to valid defaults", () => {
  localStorage.setItem("alpacawork.screen.width", "-9");
  expect(readerWidth.get()).toBeNull();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(readSetting("zoom")).toBe("");
  expect(() => writeSetting("strip", "on")).not.toThrow();
  expect(readSetting("strip")).toBe("on");
});

test("the time strips on a narrow list are off until asked for; an unknown value is off", () => {
  expect(readSetting("strip")).toBe("off");
  expect(readSetting("strip", new URL("http://localhost/?strip=time"))).toBe("off");
  localStorage.setItem("alpacawork.screen.strip", "yes");
  expect(readSetting("strip")).toBe("off");
});

test("a zoom wide enough for a long history survives a URL and device round trip", () => {
  const wide = String(150 * 86_400_000);
  writeSetting("zoom", wide);
  expect(readSetting("zoom")).toBe(wide);
  expect(new URL(location.href).searchParams.get("zoom")).toBe(wide);
  expect(localStorage.getItem("alpacawork.screen.zoom")).toBe(wide);
  expect(readSetting("zoom", new URL(`http://localhost/?zoom=${wide}`))).toBe(wide);
});

test("partial widths decode only safe px values; mode is never a device value", () => {
  for (const width of ["full", "419", "-9", "NaN", "Infinity", "9007199254740992"]) {
    localStorage.setItem("alpacawork.screen.width", width);
    expect(readerWidth.get()).toBeNull();
  }
  for (const width of [420, 976, 2096]) {
    readerWidth.set(width);
    expect(readerWidth.get()).toBe(width);
    expect(localStorage.getItem("alpacawork.screen.width")).toBe(String(width));
    expect(new URL(location.href).searchParams.get("width")).toBeNull();
  }
});

test("the list's title column is a third of a wide list between its least and its most, and tight beside the reader", () => {
  expect(titleColumnWidth(780)).toBe(330);
  expect(titleColumnWidth(900)).toBe(360);
  expect(titleColumnWidth(1392)).toBe(473);
  expect(titleColumnWidth(1900)).toBe(480);
});

test("the time strip gives up its room before the speed column loses its bars, even beside the widest reader", () => {
  // A list beside a detail at its default width on a 1440px screen; then the list the widest reader leaves (24px and 36px insets).
  expect(listColumns(833).lane).toBe(SPEED_LANE);
  for (const viewport of [1280, 1440, 1920]) expect(listColumns(viewport - readerListReservation(4000, viewport) - 60).lane).toBe(SPEED_LANE);
  // Narrower, the number alone, then nothing, so the strip keeps its floor.
  const compact = listColumns(560).lane;
  expect(compact).toBeGreaterThan(0);
  expect(compact).toBeLessThan(SPEED_LANE);
  expect(listColumns(500).lane).toBe(0);
});
