import { seedPersonal } from './read-fixtures';
import { afterEach, expect, test } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { usePersonalSettings } from "../src/data/personal-settings";
import { useApplyTheme } from "../src/state/theme";

function Theme() { useApplyTheme(); return null; }

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("[data-test-pwa]").forEach(node => node.remove());
  delete document.documentElement.dataset.theme;
  usePersonalSettings.setState(usePersonalSettings.getInitialState(), true);
});

test("switching the screen theme updates browser chrome, while the install manifest stays put", () => {
  document.head.insertAdjacentHTML("beforeend", `<style data-test-pwa>
    :root { --bg: #f4f6f9; } :root[data-theme="dark"] { --bg: #0e0f12; }
  </style><meta data-test-pwa name="theme-color" content="#f4f6f9">
  <meta data-test-pwa name="apple-mobile-web-app-status-bar-style" content="default">
  <link data-test-pwa rel="manifest" href="/manifest.webmanifest">`);
  seedPersonal({ values: { theme: "light" } });
  render(<Theme />);
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!;
  const status = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')!;
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')!;
  expect(meta.content).toBe("#f4f6f9");
  expect(manifest.getAttribute("href")).toBe("/manifest.webmanifest");
  act(() => seedPersonal({ values: { theme: "dark" } }));
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(meta.content).toBe("#0e0f12");
  expect(status.content).toBe("black");
  // The server answers the manifest with the saved theme; one stable address keeps the installed app from churning.
  expect(manifest.getAttribute("href")).toBe("/manifest.webmanifest");
});
