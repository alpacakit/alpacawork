/** Settings every browser config shares. The standard run and its areas are playwright.config.ts. */
import "./guard-loader.mjs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

process.env.ALPACAWORK_TELEMETRY_DISABLED = "1";

export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  // A later run must not erase the first failure's trace/runtime evidence.
  outputDir: resolve(".local/test-runs", `e2e-${Date.now()}-${randomUUID()}`, "browser-output"),
  fullyParallel: true,
  // A wait is how long a starved machine may take to show the result, not a demand on the product. Under other agents' load
  // a correct step passed the defaults only some of the time; a real failure still fails, later.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 4,
  forbidOnly: true,
  reporter: [["list"]],
  use: {
    // Keep the first failure's browser history, frame observations, and network order before a rerun replaces it.
    trace: "retain-on-failure",
    video: "on",
    screenshot: "only-on-failure",
    deviceScaleFactor: 1,
    // A Service Worker controlling the page sends its requests past page.route, which the checks use to lose or hold
    // answers; the check of the Service Worker itself allows it.
    serviceWorkers: "block",
    timezoneId: "Asia/Tokyo",
    locale: "en-US",
    // Context locale sets web APIs and headers, but Linux fontconfig reads the browser process's
    // locale when choosing generic fonts. Keep those metrics independent of the runner's LANG/LC_*.
    launchOptions: { env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } },
  },
});
