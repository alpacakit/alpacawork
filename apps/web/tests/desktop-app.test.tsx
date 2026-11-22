import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { isMacSafari, watchDesktopApp } from "../src/lib/desktop-app";
import { AppGuideTab } from "../src/features/panels/AppGuideTab";
import { SetupScreen } from "../src/features/setup/SetupScreen";

// The setup at its last step, whose own form is stood in for by its Finish button.
// Finishing saves the state as finished, which the read then answers, as the server's answer does.
const run = vi.hoisted(() => ({ finished: vi.fn(), left: [] as string[], data: null as unknown }));
const unfinished = { state: { step: "project", project: "P1", finishedAt: null } };
vi.mock("../src/data/first-run", () => ({
  useFirstRun: () => ({ data: run.data, isError: false }),
  useFirstRunChange: () => ({ mutate: () => {}, mutateAsync: async () => {
    run.finished(); run.data = { state: { step: "project", project: "P1", finishedAt: "2026-11-22T00:00:00Z" } }; } }),
}));
vi.mock("../src/data/workspace-store", () => ({ useFrameSelector: () => true }));
vi.mock("../src/features/setup/entrance", () => ({ leaveSetup: (url: URL) => run.left.push(url.pathname + url.search) }));
vi.mock("../src/features/setup/ProjectStep", () => ({
  ProjectStep: ({ onFinish }: { onFinish: () => Promise<void> }) => <button onClick={() => void onFinish()}>Finish setup</button>,
}));
vi.mock("../src/data/mobile-access", () => ({ useMobileAccess: () => ({ data: undefined, isPending: true, isError: false, refetch: () => {} }) }));

beforeAll(() => { startI18n(); watchDesktopApp(window); });
beforeEach(async () => { await i18n.changeLanguage("en"); run.left = []; run.data = unfinished; run.finished.mockClear(); });
afterEach(() => { cleanup(); act(() => { window.dispatchEvent(new Event("appinstalled")); }); });

/** The browser offering to install the page, answering its prompt with `outcome`. */
function offer(outcome: "accepted" | "dismissed", answered: Promise<unknown> = Promise.resolve()) {
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn(async () => {}), userChoice: answered.then(() => ({ outcome })) });
  act(() => { window.dispatchEvent(event); });
  return event;
}

const finish = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Finish setup" })); }); };

test("only Safari on a Mac is told to use its menu: not Chrome, Edge or Firefox on a Mac, nor an iPhone or iPad", () => {
  const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  expect(isMacSafari(`${mac} Version/17.4 Safari/605.1.15`, 0)).toBe(true);
  expect(isMacSafari(`${mac} Chrome/156.0.0.0 Safari/537.36`, 0)).toBe(false);
  expect(isMacSafari(`${mac} Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0`, 0)).toBe(false);
  expect(isMacSafari("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0", 0)).toBe(false);
  expect(isMacSafari("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", 5)).toBe(false);
  expect(isMacSafari(`${mac} Version/18.0 Safari/605.1.15`, 5)).toBe(false);
  // Add to Dock came with Safari 17.
  expect(isMacSafari(`${mac} Version/16.6 Safari/605.1.15`, 0)).toBe(false);
});

test("finishing setup without a way to install opens the project at once", async () => {
  render(<SetupScreen />);
  await finish();
  expect(run.left).toEqual(["/?project=P1"]);
  expect(screen.queryByText("Install as an app")).toBeNull();
});

test("with the browser's offer, finishing asks once; installing or declining both open the project", async () => {
  for (const outcome of ["accepted", "dismissed"] as const) {
    run.left = []; run.data = unfinished;
    const event = offer(outcome);
    const view = render(<SetupScreen />);
    await finish();
    expect(run.finished).toHaveBeenCalled();
    expect(run.left).toEqual([]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Install and start" })); });
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(run.left).toEqual(["/?project=P1"]);
    view.unmount();
  }
  // While the browser asks, the screen still says what is being asked (not Safari's menu), and waits for the answer.
  run.left = []; run.data = unfinished;
  let answer = () => {};
  offer("accepted", new Promise<void>(done => { answer = done; }));
  const asking = render(<SetupScreen />);
  await finish();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Install and start" })); });
  expect(screen.getByText(/the Dock or the taskbar/)).toBeTruthy();
  expect(run.left).toEqual([]);
  await act(async () => { answer(); });
  expect(run.left).toEqual(["/?project=P1"]);
  asking.unmount();
  // Starting in the browser does not ask.
  run.left = []; run.data = unfinished;
  const event = offer("accepted");
  render(<SetupScreen />);
  await finish();
  fireEvent.click(screen.getByRole("button", { name: "Start in the browser" }));
  expect(event.prompt).not.toHaveBeenCalled();
  expect(run.left).toEqual(["/?project=P1"]);
});

test("Settings shows its Install button only while the offer can be used, and the address bar otherwise", async () => {
  render(<AppGuideTab />);
  const part = () => screen.getByRole("region", { name: "Use as a desktop app" });
  expect(within(part()).getByRole("img")).toBeTruthy();
  const event = offer("dismissed");
  expect(within(part()).queryByRole("img")).toBeNull();
  await act(async () => { fireEvent.click(within(part()).getByRole("button", { name: "Install" })); });
  expect(event.prompt).toHaveBeenCalledOnce();
  // Used up: no button that would do nothing.
  expect(within(part()).queryByRole("button", { name: "Install" })).toBeNull();
  expect(within(part()).getByRole("img")).toBeTruthy();
});
