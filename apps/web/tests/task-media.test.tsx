import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import { TaskVideo, pauseTaskMedia } from "../src/features/reader/TaskMedia";
import { useToasts } from "../src/lib/notify";
import { Profiler } from "react";

/** What the video's failures said: toasts, not a line under the video. */
const said = () => useToasts.getState().toasts.filter(toast => toast.kind === "error").map(toast => String(toast.text)).join(" ");

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { value: true, configurable: true }); this.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { value: false, configurable: true }); this.dispatchEvent(new Event("play"));
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const element = () => document.querySelector("video")!;
const metadata = (v = element(), duration = 120) => {
  Object.defineProperty(v, "readyState", { value: 1, configurable: true });
  Object.defineProperty(v, "duration", { value: duration, configurable: true }); fireEvent.loadedMetadata(v);
};

test("equal media notifications retain the rendered controls while still publishing the live position", () => {
  const committed = vi.fn(), remember = vi.fn();
  render(<Profiler id="video" onRender={committed}><TaskVideo viewer src="clip.webm" onPositionChange={remember} /></Profiler>);
  metadata();
  element().currentTime = 25; fireEvent.timeUpdate(element());
  committed.mockClear(); remember.mockClear();
  for (let i = 0; i < 10; i++) fireEvent.timeUpdate(element());
  // Development React may commit its first bailout after a changed value; subsequent equal events must not repeat it.
  expect(committed.mock.calls.length).toBeLessThanOrEqual(1);
  expect(remember).toHaveBeenCalledTimes(10);
  expect(remember).toHaveBeenLastCalledWith(25);
  element().currentTime = 26; fireEvent.timeUpdate(element());
  expect(committed).toHaveBeenCalled();
  expect(screen.getByRole("slider", { name: "Playback position" }).getAttribute("aria-valuetext")).toBe("0:26 / 2:00");
});

test("only a slider opts into the control row; live media events drive its state and unknown duration cannot seek", () => {
  const view = render(<TaskVideo src="clip.webm" aria-label="clip" />);
  expect(element().controls).toBe(true);
  expect(screen.queryByRole("slider")).toBeNull();
  view.rerender(<TaskVideo viewer src="clip.webm" aria-label="clip" />);
  expect(element().controls).toBe(false);
  expect((screen.getByRole("slider", { name: "Playback position" }) as HTMLInputElement).disabled).toBe(true);
  metadata();
  element().currentTime = 25; fireEvent.timeUpdate(element());
  expect(screen.getByRole("slider", { name: "Playback position" }).getAttribute("aria-valuetext")).toBe("0:25 / 2:00");
  fireEvent.play(element());
  Object.defineProperty(element(), "paused", { value: false, configurable: true }); fireEvent.play(element());
  expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  metadata(element(), Infinity);
  expect((screen.getByRole("slider", { name: "Playback position" }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByRole("slider", { name: "Playback position" }).getAttribute("aria-valuetext")).not.toMatch(/Infinity|NaN/);
});

test("a play rejection leaves a usable paused player and a readable reason, distinct from a decode failure", async () => {
  render(<TaskVideo viewer src="clip.webm" aria-label="clip" />);
  vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  await waitFor(() => expect(said()).toContain("Could not start"));
  expect(document.querySelector("[data-video-status]")).toBeNull();
  fireEvent.error(element());
  expect(screen.getByRole("status").textContent).toContain("Video unavailable: clip");
  expect(screen.queryByRole("slider")).toBeNull();
});

for (const kind of ["reject", "throw", "absent"] as const) test(`fullscreen ${kind} restores inline controls and reports the failure`, async () => {
  render(<TaskVideo viewer src="clip.webm" />);
  if (kind !== "absent") Object.defineProperty(element(), "requestFullscreen", { configurable: true,
    value: kind === "throw" ? () => { throw new Error("unavailable"); } : () => Promise.reject(new Error("denied")) });
  fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
  await waitFor(() => expect(said()).toContain("Could not open full screen"));
  expect(element().controls).toBe(false);
  expect(element().hasAttribute("data-video-fullscreen")).toBe(false);
});

test("WebKit begin/end are browser-boundary signals; source replacement clears the old lifetime", () => {
  const view = render(<TaskVideo viewer src="first.webm" />);
  const first = element();
  fireEvent(first, new Event("webkitbeginfullscreen"));
  expect(first.controls).toBe(true);
  expect(first.hasAttribute("data-video-fullscreen")).toBe(true);
  fireEvent(first, new Event("webkitendfullscreen"));
  expect(first.controls).toBe(false);
  metadata(first, 8000);
  view.rerender(<TaskVideo viewer src="second.webm" />);
  expect(element()).not.toBe(first);
  expect(first.paused).toBe(true);
  expect((screen.getByRole("slider", { name: "Playback position" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent(first, new Event("webkitbeginfullscreen"));
  expect(element().controls).toBe(false);
});

test("unmount pauses a play whose promise completes after its video has left", async () => {
  let finish!: () => void;
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = render(<TaskVideo viewer src="clip.webm" />);
  const removed = element();
  fireEvent.click(screen.getByRole("button", { name: "Play" }));
  view.unmount();
  await act(async () => { Object.defineProperty(removed, "paused", { value: false, configurable: true }); finish(); });
  expect(removed.paused).toBe(true);
});

test("revisit position is a bounded initial snapshot and cleanup publishes the final position", () => {
  const remember = vi.fn();
  const view = render(<TaskVideo viewer src="clip.webm" startAt={500} onPositionChange={remember} />);
  metadata(element(), 20);
  expect(element().currentTime).toBe(20);
  element().currentTime = 7;
  view.unmount();
  expect(remember).toHaveBeenLastCalledWith(7);
});

test("a fullscreen request that enters after unmount leaves only its old video and cannot restore native inline controls", async () => {
  let finish!: () => void;
  const view = render(<TaskVideo viewer src="clip.webm" />);
  const removed = element();
  Object.defineProperty(removed, "requestFullscreen", { value: () => new Promise<void>(resolve => { finish = resolve; }) });
  const exit = vi.fn(async () => { Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true }); });
  Object.defineProperty(document, "exitFullscreen", { value: exit, configurable: true });
  fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
  view.unmount();
  await act(async () => {
    Object.defineProperty(document, "fullscreenElement", { value: removed, configurable: true }); finish();
  });
  expect(exit).toHaveBeenCalledTimes(1);
  expect(removed.controls).toBe(false);
  delete (document as unknown as { fullscreenElement?: Element | null }).fullscreenElement;
  delete (document as unknown as { exitFullscreen?: () => Promise<void> }).exitFullscreen;
});

test("volume zero can be unmuted, volume changes unmute, and labels follow the element", () => {
  render(<TaskVideo viewer src="clip.webm" />);
  fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0" } });
  fireEvent.volumeChange(element());
  fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
  fireEvent.volumeChange(element());
  expect(element().volume).toBe(1);
  expect(element().muted).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Mute" }));
  fireEvent.volumeChange(element());
  expect(screen.getByRole("button", { name: "Unmute" })).toBeTruthy();
  fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0.3" } });
  expect(element().muted).toBe(false);
  expect(element().volume).toBe(.3);
});

test("one registry stops videos in both documents, pagehide stops the detached-window element, and cleanup unregisters it", async () => {
  const frame = document.createElement("iframe"); document.body.append(frame);
  const at = frame.contentDocument!;
  const main = render(<TaskVideo src="main.webm" />);
  const other = render(<TaskVideo src="other.webm" />, { container: at.body });
  const a = main.container.querySelector("video")!, b = at.querySelector("video")!;
  // jsdom gives the iframe its own unimplemented media prototype too.
  b.play = a.play.bind(b); b.pause = a.pause.bind(b);
  await act(async () => { await a.play(); await b.play(); });
  expect(a.paused).toBe(true); expect(b.paused).toBe(false);
  act(() => { at.defaultView!.dispatchEvent(new Event("pagehide")); });
  expect(b.paused).toBe(true);
  other.unmount();
  const pause = vi.spyOn(b, "pause"); pause.mockClear();
  act(() => pauseTaskMedia());
  expect(pause).not.toHaveBeenCalled();
  frame.remove();
});


test("leaving before metadata preserves the revisit snapshot, while an intentional zero is saved", () => {
  const remember = vi.fn();
  const view = render(<TaskVideo viewer src="clip.webm" startAt={7} onPositionChange={remember} />);
  view.unmount();
  expect(remember).not.toHaveBeenCalled();
  const loaded = render(<TaskVideo viewer src="clip.webm" startAt={7} onPositionChange={remember} />);
  metadata();
  expect(element().currentTime).toBe(7);
  element().currentTime = 0;
  loaded.unmount();
  expect(remember).toHaveBeenLastCalledWith(0);
});

test("a media write failure reports its cause and draws the real value, then a successful action recovers", () => {
  render(<TaskVideo viewer src="clip.webm" />);
  const recorded = vi.spyOn(console, "error").mockImplementation(() => {});
  Object.defineProperty(element(), "volume", { configurable: true, get: () => 1, set: () => { throw new Error("injected volume setter"); } });
  fireEvent.change(screen.getByRole("slider", { name: "Volume" }), { target: { value: "0" } });
  expect(said()).toContain("Could not change");
  expect(recorded).toHaveBeenCalledWith("[task video controls]", expect.any(Error));
  expect((screen.getByRole("slider", { name: "Volume" }) as HTMLInputElement).value).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Mute" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(element().muted).toBe(true);
});

test("both ranges own focus on pointer start and seek arrows move five seconds independent of length", () => {
  render(<TaskVideo viewer src="clip.webm" />);
  metadata(element(), 8000);
  const seek = screen.getByRole("slider", { name: "Playback position" });
  fireEvent.pointerDown(seek, { pointerType: "touch" });
  expect(document.activeElement).toBe(seek);
  fireEvent.keyDown(seek, { key: "ArrowRight" });
  expect(element().currentTime).toBeCloseTo(5.001);
  fireEvent.keyDown(seek, { key: "ArrowLeft" });
  expect(element().currentTime).toBeCloseTo(.001);
  const volume = screen.getByRole("slider", { name: "Volume" });
  fireEvent.pointerDown(volume, { pointerType: "touch" });
  expect(document.activeElement).toBe(volume);
});
