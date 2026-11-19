import { defineConfig } from "@playwright/test";
import config from "../playwright.base.ts";
export default defineConfig({
  ...config, globalSetup: process.env.CAPTURE_RUNTIME === "shared" ? "../global-setup.ts" : undefined, testDir: ".",
  testMatch: process.env.CAPTURE_CLEANUP_FAULT ? "03-cleanup.case.ts" : ["01-first.case.ts", "02-second.case.ts"], fullyParallel: false, workers: 1,
  outputDir: process.env.CAPTURE_OUTPUT,
  reporter: [["json", { outputFile: process.env.CAPTURE_REPORT }]],
  use: { ...config.use, trace: process.env.CAPTURE_TRACE === "on" ? "retain-on-failure" : "off" },
});
