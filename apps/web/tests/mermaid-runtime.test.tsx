import { palette } from "./mermaid-palette";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MERMAID_CHANNEL, MERMAID_TIMEOUT_MS, type FrameResult, type FrameRequest } from "../src/lib/mermaid-protocol";

beforeEach(() => { vi.resetModules(); });
afterEach(() => { window.dispatchEvent(new Event("pagehide")); vi.useRealTimers(); });
function message(frame: HTMLIFrameElement, data: unknown, origin = window.location.origin, source: MessageEventSource | null = frame.contentWindow) {
  window.dispatchEvent(new MessageEvent("message", { origin, source, data }));
}
async function renderer() {
  await vi.waitFor(() => expect(document.querySelector("[data-mermaid-frame]")).not.toBeNull());
  const frame = document.querySelector<HTMLIFrameElement>("[data-mermaid-frame]")!;
  const send = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  message(frame, { channel: MERMAID_CHANNEL, ready: true });
  const reply = (result: FrameResult) => {
    const request = send.mock.calls.at(-1)![0] as FrameRequest;
    message(frame, { channel: MERMAID_CHANNEL, id: request.id, result });
  };
  return { frame, send, reply };
}

test("one frame serializes requests, shares cached work and keeps themes distinct", async () => {
  const { renderMermaid } = await import("../src/lib/mermaid");
  const first = renderMermaid("A", palette("light"));
  expect(renderMermaid("A", palette("light"))).toBe(first);
  const second = renderMermaid("B", palette("dark"));
  const { frame, send, reply } = await renderer();
  expect(frame.getAttribute("src")).toBe("/mermaid-frame.html");
  expect(frame.getAttribute("aria-hidden")).toBe("true");
  expect(frame.style.width).toBe("1280px");
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]).toEqual([expect.objectContaining({ source: "A", palette: expect.objectContaining({ theme: "light", fontFamily: expect.any(String) }) }), window.location.origin]);
  reply({ ok: true, svg: '<svg width="687"/>', width: 687, height: 191 });
  expect(await first).toEqual({ ok: true, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg width="687"/>')}`, width: 687, height: 191 });
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  reply({ ok: false, reason: "Invalid diagram" });
  expect(await second).toEqual({ ok: false, reason: "Invalid diagram" });
  const dark = renderMermaid("A", palette("dark"));
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  reply({ ok: true, svg: "<svg/>" });
  expect((await dark).ok).toBe(true);
  expect(document.querySelectorAll("[data-mermaid-frame]")).toHaveLength(1);
});

test("only a matching, validated reply from the owned same-origin frame can complete a request", async () => {
  const { renderMermaid } = await import("../src/lib/mermaid");
  const result = renderMermaid("source", palette("light"));
  const { frame, send, reply } = await renderer();
  const id = (send.mock.calls[0]![0] as FrameRequest).id;
  const data = { channel: MERMAID_CHANNEL, id, result: { ok: true, svg: "<svg/>" } };
  message(frame, data, "https://example.invalid");
  message(frame, data, window.location.origin, window);
  message(frame, { ...data, id: id + 1 });
  message(frame, { ...data, result: { ...data.result, width: -1 } });
  message(frame, { channel: MERMAID_CHANNEL, ready: true });
  expect(send).toHaveBeenCalledTimes(1);
  let settled = false; void result.then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  reply({ ok: true, svg: "<svg/>" });
  expect((await result).ok).toBe(true);
});

test("frame load failure cleans up and the next source creates a fresh frame", async () => {
  const { renderMermaid } = await import("../src/lib/mermaid");
  const failed = renderMermaid("A", palette("light"));
  const { frame } = await renderer();
  frame.dispatchEvent(new Event("error"));
  expect(await failed).toEqual({ ok: false, reason: "Could not load diagram frame" });
  expect(frame.isConnected).toBe(false);
  const next = renderMermaid("B", palette("light"));
  const fresh = await renderer();
  expect(fresh.frame).not.toBe(frame);
  fresh.reply({ ok: true, svg: "<svg/>" });
  expect((await next).ok).toBe(true);
});

test.each([false, true])("deadline removes the frame and its pending work (ready=%s)", async ready => {
  vi.useFakeTimers();
  const { renderMermaid } = await import("../src/lib/mermaid");
  const result = renderMermaid("stalled", palette("light"));
  await Promise.resolve();
  if (ready) await renderer();
  await vi.advanceTimersByTimeAsync(MERMAID_TIMEOUT_MS);
  expect(await result).toEqual({ ok: false, reason: "Diagram frame timed out" });
  expect(document.querySelector("[data-mermaid-frame]")).toBeNull();
});

test("page teardown releases the frame and resolves pending work", async () => {
  const { renderMermaid } = await import("../src/lib/mermaid");
  const result = renderMermaid("pending", palette("light"));
  await renderer();
  window.dispatchEvent(new Event("pagehide"));
  expect(await result).toEqual({ ok: false, reason: "Diagram page closed" });
  expect(document.querySelector("[data-mermaid-frame]")).toBeNull();
});

test("a frame that cannot be created returns a displayable failure", async () => {
  const append = vi.spyOn(document.body, "append").mockImplementationOnce(() => { throw new Error("Unavailable DOM"); });
  const { renderMermaid } = await import("../src/lib/mermaid");
  expect(await renderMermaid("source", palette("light"))).toEqual({ ok: false, reason: "Unavailable DOM" });
  append.mockRestore();
  expect(document.querySelector("[data-mermaid-frame]")).toBeNull();
});

test("the same source/theme cannot reuse a result from an earlier CSS palette", async () => {
  const { renderMermaid } = await import("../src/lib/mermaid");
  const first = renderMermaid("A", palette());
  const { send, reply } = await renderer();
  reply({ ok: true, svg: "<svg>old</svg>" });
  await first;
  const updated = { ...palette(), node: "#aabbcc" };
  const next = renderMermaid("A", updated);
  expect(next).not.toBe(first);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  expect((send.mock.calls.at(-1)![0] as FrameRequest).palette.node).toBe("#aabbcc");
  reply({ ok: true, svg: "<svg>new</svg>" });
  expect(await next).toMatchObject({ src: expect.stringContaining("new") });
  expect(renderMermaid("A", { ...updated })).toBe(next);
});
