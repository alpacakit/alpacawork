import { useState } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { deviceValue, jsonCodec, useDeviceValue } from "../src/lib/device-storage";

let sequence = 0;
const sample = () => {
  const key = `alpacawork.test.${sequence++}` as const;
  const check = vi.fn((value: unknown) => typeof value === "object" && value !== null && "height" in value
    && typeof value.height === "number" && Number.isFinite(value.height) ? { height: Math.round(value.height) } : null);
  const fallback = { height: 600 };
  return { key, check, fallback, setting: deviceValue(key, jsonCodec(check), fallback) };
};
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null })); });

test("raw values are checked once, cached with stable identity, removed and invalidated", () => {
  const { key, setting, fallback, check } = sample();
  expect(setting.get()).toBe(fallback);
  localStorage.setItem(key, "broken"); expect(setting.get()).toBe(fallback);
  localStorage.setItem(key, '{"height": "bad"}'); expect(setting.get()).toBe(fallback);
  expect(setting.set({ height: 460.2 })).toBe("stored");
  expect(localStorage.getItem(key)).toBe('{"height":460.2}');
  const kept = setting.get(), calls = check.mock.calls.length;
  expect(kept).toEqual({ height: 460 }); expect(setting.get()).toBe(kept); expect(check).toHaveBeenCalledTimes(calls);
  setting.remove(); expect(localStorage.getItem(key)).toBeNull(); expect(setting.get()).toBe(fallback);
  expect(() => deviceValue(key, jsonCodec(check), fallback)).toThrow("already registered");
});

test("same-tab consumers and other-tab set/remove/clear use the same cache and never write on refresh", () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { key, setting, fallback } = sample();
  function Display() { return <span>{useDeviceValue(setting).height}</span>; }
  render(<><Display /><Display /></>);
  act(() => { setting.set({ height: 460 }); }); expect(screen.getAllByText("460")).toHaveLength(2);
  const notify = vi.fn(), stop = setting.subscribe(notify);
  localStorage.setItem(key, '{"height":510}');
  const write = vi.spyOn(Storage.prototype, "setItem");
  act(() => window.dispatchEvent(new StorageEvent("storage", { key, storageArea: sessionStorage })));
  expect(notify).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new StorageEvent("storage", { key, newValue: '{"height":123}' })));
  expect(screen.getAllByText("510")).toHaveLength(2); expect(notify).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled();
  localStorage.removeItem(key);
  act(() => window.dispatchEvent(new StorageEvent("storage", { key })));
  expect(setting.get()).toBe(fallback); expect(screen.getAllByText("600")).toHaveLength(2);
  act(() => { setting.set({ height: 480 }); }); localStorage.clear();
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
  expect(screen.getAllByText("600")).toHaveLength(2); stop();
});

test("storage denial keeps a single in-memory value; resuming a page preserves it until storage changes", () => {
  const { key, setting } = sample();
  const notify = vi.fn(); setting.subscribe(notify);
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied"); });
  expect(setting.get()).toEqual({ height: 600 }); get.mockRestore();
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("quota"); });
  expect(setting.set({ height: 460 })).toBe("memory"); expect(setting.get()).toEqual({ height: 460 });
  window.dispatchEvent(new Event("pageshow")); expect(setting.get()).toEqual({ height: 460 });
  set.mockRestore(); localStorage.setItem(key, '{"height":530}');
  window.dispatchEvent(new Event("pageshow")); expect(setting.get()).toEqual({ height: 530 });
  const property = vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("blocked"); });
  expect(setting.set({ height: 470 })).toBe("memory"); expect(setting.get()).toEqual({ height: 470 });
  property.mockRestore(); expect(notify).toHaveBeenCalledTimes(3);
});

test("the app's direct accesses belong only to the registered storage owner", () => {
  const root = fileURLToPath(new URL("../src/", `file://${__filename}`));
  const scan = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? scan(path) : /\.[cm]?[jt]sx?$/.test(path) && /\blocalStorage\b/.test(readFileSync(path, "utf8")) ? [path.slice(root.length)] : [];
  });
  expect(scan(root)).toEqual(["/lib/device-storage.ts"]);
});

test.each(["set", "remove"] as const)("a stale notification never discards a refused %s while durable raw is unchanged", (operation) => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { key, setting, fallback } = sample();
  setting.set({ height: 500 });
  const notify = vi.fn(); setting.subscribe(notify);
  const refused = vi.spyOn(Storage.prototype, operation === "set" ? "setItem" : "removeItem").mockImplementation(() => { throw new DOMException("quota"); });
  if (operation === "set") setting.set({ height: 460 }); else setting.remove();
  const held = setting.get(); expect(held).toEqual(operation === "set" ? { height: 460 } : fallback);
  notify.mockClear();
  for (const event of [new StorageEvent("storage", { key }), new Event("pageshow"), new Event("visibilitychange"), new StorageEvent("storage", { key: null })]) {
    (event.type === "visibilitychange" ? document : window).dispatchEvent(event); expect(setting.get()).toBe(held);
  }
  expect(notify).not.toHaveBeenCalled();
  refused.mockRestore(); localStorage.setItem(key, '{"height":530}');
  window.dispatchEvent(new StorageEvent("storage", { key }));
  expect(setting.get()).toEqual({ height: 530 }); expect(notify).toHaveBeenCalledTimes(1);
  localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(setting.get()).toBe(fallback); expect(notify).toHaveBeenCalledTimes(2);
});

test.each(["storage", "pageshow", "visibilitychange", "set", "remove"] as const)("a get before %s cannot consume an unpublished change", (publication) => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { key, setting, fallback } = sample();
  function Display() { return <span>{useDeviceValue(setting).height}</span>; }
  render(<><Display /><Display /></>);
  act(() => { setting.set({ height: 460 }); });
  if (publication === "remove") localStorage.removeItem(key); else localStorage.setItem(key, '{"height":530}');
  const next = setting.get();
  expect(next).toEqual(publication === "remove" ? fallback : { height: 530 });
  act(() => {
    if (publication === "set") setting.set(next);
    else if (publication === "remove") setting.remove();
    else (publication === "visibilitychange" ? document : window).dispatchEvent(publication === "storage" ? new StorageEvent("storage", { key }) : new Event(publication));
  });
  expect(screen.getAllByText(String(next.height))).toHaveLength(2);
  const notify = vi.fn(); setting.subscribe(notify);
  window.dispatchEvent(new StorageEvent("storage", { key }));
  expect(setting.get()).toBe(next); expect(notify).not.toHaveBeenCalled();
});

test.each(["storage-remove", "storage-clear", "storage-set", "pageshow", "visibilitychange", "set", "remove"] as const)("an observed intermediate value returning to its original value is published through %s", (publication) => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const key = `alpacawork.test.${sequence++}` as const;
  const setting = deviceValue(key, { read: Number, write: String }, 0);
  let bump!: () => void;
  function First() { const [, renderAgain] = useState(0); bump = () => renderAgain(n => n + 1); return <span>{useDeviceValue(setting)}</span>; }
  function Second() { return <span>{useDeviceValue(setting)}</span>; }
  render(<><First /><Second /></>);
  localStorage.setItem(key, "42"); act(() => bump());
  expect(screen.getAllByText("42")).toHaveLength(1); expect(screen.getAllByText("0")).toHaveLength(1);
  const notify = vi.fn(), stop = setting.subscribe(notify);
  act(() => {
    if (publication === "set") setting.set(0);
    else if (publication === "remove") setting.remove();
    else {
      if (publication === "storage-remove") localStorage.removeItem(key);
      else if (publication === "storage-clear") localStorage.clear();
      else localStorage.setItem(key, "0");
      if (publication.startsWith("storage")) window.dispatchEvent(new StorageEvent("storage", { key: publication === "storage-clear" ? null : key }));
      else (publication === "visibilitychange" ? document : window).dispatchEvent(new Event(publication));
    }
  });
  expect(screen.getAllByText("0")).toHaveLength(2); expect(notify).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new StorageEvent("storage", { key })); expect(notify).toHaveBeenCalledTimes(1); stop();
});
