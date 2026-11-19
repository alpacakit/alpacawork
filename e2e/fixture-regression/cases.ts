import type { Page, TestInfo } from "@playwright/test";
import { SAMPLE_NOW } from "../fixture/sample.ts";
import type { Runtime } from "../server.ts";
import { readOnlyTest, test as base, open, expect } from "../fixtures.ts";
import { chmodSync, existsSync, linkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Both files import this one TestType: the successful first file must not restart the worker.
const runtimeTest = process.env.CAPTURE_RUNTIME === "prepared" ? readOnlyTest(() => {}) : base;
// Put options on the shared TestType. A test.use() in a cached imported module only configures the first file's suite.
export const test = runtimeTest.extend({
  isolated: process.env.CAPTURE_RUNTIME !== "shared", fixedTime: process.env.CAPTURE_REAL_TIME !== "1",
});
export async function exercise({ page, runtime }: { page: Page; runtime: Runtime }, info: TestInfo, first: boolean) {
  // Deliberately break real capture boundaries, not a second capture implementation.
  const fault = process.env.CAPTURE_FAULT;
  if (fault === "backup") mkdirSync(info.outputPath("runtime-control.sqlite"));
  if (fault === "attachment") {
    const attach = info.attach.bind(info);
    info.attach = async (name, options) => {
      if (name === "runtime-control") throw new Error("deliberate capture attachment fault");
      await attach(name, options);
    };
  }
  const clock = await page.evaluate(() => Date.now());
  const fixedTime = process.env.CAPTURE_REAL_TIME !== "1";
  const clockEvidence = { browser: clock, host: Date.now(), fixedTime, sample: Date.parse(SAMPLE_NOW) };
  writeFileSync(info.outputPath("clock.json"), JSON.stringify(clockEvidence));
  expect(fixedTime ? clock === clockEvidence.sample : Math.abs(clock - clockEvidence.host) < 5000, JSON.stringify(clockEvidence)).toBe(true);
  if (fault === 'workspace') {
    const denied = join(runtime.root, 'capture-denied.txt');
    writeFileSync(denied, 'capture must report this failed file copy'); chmodSync(denied, 0);
  }
  const marker = `capture-${info.title}`;
  writeFileSync(join(runtime.root, "capture-marker.txt"), marker);
  if (!existsSync(join(runtime.root, 'capture-marker-link.txt')))
    linkSync(join(runtime.root, 'capture-marker.txt'), join(runtime.root, 'capture-marker-link.txt'));
  await open(page, runtime, "?task=T111&agent=1");
  await page.getByRole("complementary").getByText("T111", { exact: true }).first().waitFor();
  const response = await fetch(`${runtime.origin}/api/workspace/live`);
  expect(response.status).toBe(200);
  const before = { root: runtime.root, origin: runtime.origin, workerIndex: info.workerIndex,
    pid: process.pid, deadline: new Date(Date.now() + 120_000).toISOString(), marker,
    api: await response.json() };
  writeFileSync(info.outputPath("before.json"), JSON.stringify(before));
  if (!first && process.env.CAPTURE_CLOSE_PAGE === "1") await page.close();
  expect(first && process.env.CAPTURE_SEQUENCE === "after-pass", "deliberate inner failure for the outer evidence assertion").toBe(true);
}
