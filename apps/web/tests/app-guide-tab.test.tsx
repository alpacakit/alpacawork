import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { AppGuideTab } from "../src/features/panels/AppGuideTab";
import { useDialogStore } from "../src/state/dialog-store";

const query = vi.hoisted(() => ({ data: undefined as undefined | { status: "serving" | "unverified"; publicUrl: string | null; localUrl: string | null },
  isPending: false, isError: false, refetch: vi.fn() }));
vi.mock("../src/data/mobile-access", () => ({ useMobileAccess: () => query }));
const clip = vi.hoisted(() => ({ texts: [] as string[] }));
vi.mock("../src/lib/clipboard", () => ({
  textClip: (text: string) => ({ text }),
  writeClip: (value: { text: string }) => { clip.texts.push(value.text); return Promise.resolve(true); },
}));
beforeAll(() => startI18n());
beforeEach(async () => { await i18n.changeLanguage("en"); clip.texts = []; Object.assign(query, {
  data: { status: "serving", publicUrl: null, localUrl: "http://127.0.0.1:5682/" }, isPending: false, isError: false }); query.refetch.mockClear(); });
afterEach(() => { cleanup(); useDialogStore.setState(useDialogStore.getInitialState()); });

const part = (name: string) => screen.getByRole("region", { name });
const prompt = () => document.querySelector("[data-ask-prompt]");

test("in a browser the desktop part shows where Install is; an installed app's window, which has no address bar, says it is installed", () => {
  const view = render(<AppGuideTab />);
  expect(within(part("Use as a desktop app")).getByRole("img")).toBeTruthy();
  view.unmount();
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(media => ({ ...original(media), matches: media === "(display-mode: standalone)" }));
  render(<AppGuideTab />);
  expect(within(part("Use as a desktop app")).queryByRole("img")).toBeNull();
  expect(part("Use as a desktop app").textContent).toContain("installed app");
});

test("without a published URL, the instruction for an AI copies as shown and no QR is drawn", async () => {
  render(<AppGuideTab />);
  const phone = part("Use from your phone");
  expect(within(phone).getAllByRole("listitem")).toHaveLength(3);
  fireEvent.click(within(phone).getByRole("button", { name: "Copy the instruction" }));
  await screen.findByRole("button", { name: "Copied" });
  expect(clip.texts).toEqual([prompt()!.textContent]);
  expect(within(phone).queryByRole("img")).toBeNull();
});

test("the configured URL and its QR replace the instruction, and disappear when the read fails or becomes unverified", () => {
  const url = "https://pc.example.ts.net:8443/";
  query.data = { status: "serving", publicUrl: url, localUrl: "http://127.0.0.1:5682/" };
  const view = render(<AppGuideTab />);
  const phone = part("Use from your phone");
  expect(within(phone).getByRole("link", { name: url }).getAttribute("href")).toBe(url);
  expect(within(phone).getByRole("img")).toBeTruthy();
  expect(within(phone).getByRole("button", { name: "Copy URL" })).toBeTruthy();
  expect(prompt()).toBeNull();
  query.isError = true; view.rerender(<AppGuideTab />);
  expect(within(phone).queryByRole("img")).toBeNull();
  expect(within(phone).queryByRole("link", { name: url })).toBeNull();
  expect(prompt()).toBeTruthy();
  fireEvent.click(within(phone).getByRole("button", { name: "Retry" }));
  expect(query.refetch).toHaveBeenCalledOnce();
  query.isError = false; query.data.status = "unverified"; view.rerender(<AppGuideTab />);
  expect(within(phone).queryByRole("img")).toBeNull();
  expect(within(phone).getByRole("alert")).toBeTruthy();
});

test("while the URL is being checked, the steps stay and no QR is drawn", () => {
  query.data = undefined; query.isPending = true;
  render(<AppGuideTab />);
  const phone = part("Use from your phone");
  expect(within(phone).getByRole("status")).toBeTruthy();
  expect(within(phone).getAllByRole("listitem")).toHaveLength(3);
  expect(within(phone).queryByRole("img")).toBeNull();
});

test("the notifications part opens this device's notification settings", () => {
  render(<AppGuideTab />);
  fireEvent.click(within(part("Get notifications")).getByRole("button"));
  expect(useDialogStore.getState().dialog).toMatchObject({ kind: "settings", tab: "personal", focusNotifications: true });
});
