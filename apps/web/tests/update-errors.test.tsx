import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { defaultSettings } from "@alpacawork/contract";
import { activateLocale, startI18n } from "@alpacawork/i18n";
import { seedPersonal } from "./read-fixtures";
import { queryClient } from "../src/data/query-client";
import { continueUpdate, pressUpdate, useUpdateLocal } from "../src/features/update/update-state";
import { useToasts } from "../src/lib/notify";

beforeAll(async () => { await startI18n(); await activateLocale("ja"); });
afterEach(() => { queryClient.clear(); useToasts.setState({ toasts: [] }); vi.restoreAllMocks(); });
test("a refused update press says the one sentence for the person; the release's reason stays out of the notice", async () => {
  queryClient.clear(); useToasts.setState({ toasts: [] }); useUpdateLocal.setState({ sending: false, confirm: null });
  seedPersonal({ root: "/fixture", values: { ...defaultSettings(), "update.confirm": false }, revision: "r1" });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("update/review")) return Response.json({ kind: "ready", candidateId: "c1", version: "0.10.0", reviewDigest: "a".repeat(64), skills: ["alpacawork"], resume: null });
    if (String(url).includes("update/confirm")) return Response.json({ error: { code: "conflict", message: "Update refused: stale", retry: "reread", detail: { reason: "stale" }, reason: { kind: "update_refused", reason: "stale" } } }, { status: 409 });
    return Response.json({ kind: "none" });
  });
  await pressUpdate({ kind: "available", candidateId: "c1", version: "0.10.0", runs: 0, requiresNoRuns: false, changes: null, note: null });
  const notices = useToasts.getState().toasts;
  expect(notices.length).toBeGreaterThan(0);
  expect(notices.map(toast => toast.detail).join("\n")).not.toContain("stale");
});

test("a refused start says its sentence, not a key", async () => {
  queryClient.clear(); useToasts.setState({ toasts: [] }); useUpdateLocal.setState({ sending: false, confirm: null });
  seedPersonal({ root: "/fixture", values: { ...defaultSettings(), language: "ja", "update.confirm": false }, revision: "r1" });
  activateLocale("ja");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ kind: "unavailable" }));
  await pressUpdate({ kind: "available", candidateId: "c1", version: "0.10.0", runs: 0, requiresNoRuns: false, changes: null, note: null });
  expect(useToasts.getState().toasts.map(toast => toast.text)).toEqual(["アップデートを始められませんでした。しばらくして、もう一度お試しください。"]);
});

test("a refused Continue says its own sentence, not a key", async () => {
  queryClient.clear(); useToasts.setState({ toasts: [] }); useUpdateLocal.setState({ sending: false, confirm: null });
  seedPersonal({ root: "/fixture", values: { ...defaultSettings(), language: "ja" }, revision: "r1" });
  activateLocale("ja");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ kind: "unavailable" }));
  await continueUpdate({ kind: "attention", opId: "4f9c2c1e-8a8b-4a43-9a4d-6f1d2f0b9c11", version: "0.10.0" });
  expect(useToasts.getState().toasts.map(toast => toast.text)).toEqual(["続けられませんでした。しばらくして、もう一度お試しください。"]);
});

test("a confirm whose answer is lost in the switch leaves no unknown-result notice", async () => {
  queryClient.clear(); useToasts.setState({ toasts: [] }); useUpdateLocal.setState({ sending: false, confirm: null });
  seedPersonal({ root: "/fixture", values: { ...defaultSettings(), "update.confirm": false }, revision: "r1" });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("update/review")) return Response.json({ kind: "ready", candidateId: "c1", version: "0.10.0", reviewDigest: "a".repeat(64), skills: ["alpacawork"], resume: null });
    throw new TypeError("Failed to fetch");
  });
  await pressUpdate({ kind: "available", candidateId: "c1", version: "0.10.0", runs: 0, requiresNoRuns: false, changes: null, note: null });
  expect(useToasts.getState().toasts).toEqual([]);
});
