import { expect, test } from "vitest";
import type { AutomationVersion } from "@alpacawork/contract/automation-program";
import { toPreview, toVersion } from "../src/features/automations/adapt";
import { writtenEvent } from "../src/features/automations/data";
import { serverPreview } from "./automation-fixture";

// The server's own answers, turned into what the screen draws.

test("a version the coordinator saved says so, with the person's words it was asked in", () => {
  const facts = { when: { event: "signal", where: null, textKey: "trigger.signal", filter: null },
    limits: { perDay: 1, cooldownMinutes: 0, waitForPrevious: true, until: null, timeoutMinutes: 10, aiCallsPerDay: 20, tasksPerRun: 0, timezone: "UTC" }, ai: [], outside: [] };
  const version = (savedBy: unknown) => toVersion({ digest: "sha256:" + "a".repeat(64), contractVersion: 1, savedAt: "2026-11-27T00:00:00.000Z", savedBy, files: [],
    facts, docs: { run: { summary: "s", body: "", params: [], returns: null, throws: [] }, trigger: null }, parts: [], outsideEffects: [], sourceRequest: null,
    review: { state: "ok", findings: [], summary: "", model: null, at: "2026-11-27T00:00:00.000Z", acknowledged: null }, preview: null });
  expect(version({ kind: "main", provider: "claude", conversationId: "c1", quote: "only from 3 on" }).savedBy).toEqual({ kind: "coordinator", name: null, request: "only from 3 on" });
  expect(version({ kind: "main", provider: "claude", conversationId: "c1" }).savedBy).toEqual({ kind: "coordinator", name: null, request: null });
  expect(version({ kind: "human" }).savedBy.kind).toBe("person");
  expect(version({ kind: "placement", placementId: "P1" }).savedBy.kind).toBe("agent");
});

test("a showing whose run failed after trigger let it through is one where run was shown, with its error", () => {
  const failed = { ...serverPreview("s1", "passes", [], null, true), outcome: { state: "failed", summary: null, report: null, notify: false, error: { message: "boom", file: "main.ts", line: 3 } } };
  const shown = toPreview(failed as Parameters<typeof toPreview>[0]);
  expect([shown.ran, shown.outcome?.error?.message]).toEqual([true, "boom"]);
});

test("what a person writes for a signal goes to the server as one signal holding it; another kind's fields go over the event's own", () => {
  const signal = writtenEvent("signal", '{"result":"failed"}') as { kind: string; manual: boolean; count: number; items: { data: unknown; by: unknown }[] };
  expect([signal.kind, signal.manual, signal.count, signal.items[0]!.data, signal.items[0]!.by]).toEqual(["signal", true, 1, { result: "failed" }, { kind: "human" }]);
  const pressure = writtenEvent("host.pressure", '{"kinds":["disk"],"phase":"entered","episodeStartedAt":"2026-11-27T00:00:00.000Z"}') as Record<string, unknown>;
  expect([pressure.kind, pressure.kinds, pressure.manual]).toEqual(["host.pressure", ["disk"], true]);
});

test("an AI row is said as a short judgement or as whom a task goes to only when the server read it used one way alone", () => {
  const facts = { when: { event: "signal", where: null, textKey: "trigger.signal", filter: null },
    limits: { perDay: 1, cooldownMinutes: 0, waitForPrevious: true, until: null, timeoutMinutes: 10, aiCallsPerDay: 20, tasksPerRun: 1, timezone: "UTC" }, outside: [],
    ai: [{ name: "judge", agent: "claude", model: "haiku", effort: "low", uses: ["ai.ask"], costHint: null },
      { name: "worker", agent: "codex", model: "sol", effort: "high", uses: ["tasks.create"], costHint: null },
      { name: "both", agent: "codex", model: "sol", effort: "high", uses: ["ai.ask", "tasks.create"], costHint: null },
      { name: "unread", agent: "codex", model: "sol", effort: "high", uses: null, costHint: null }] };
  const shown = toVersion({ digest: "sha256:" + "a".repeat(64), contractVersion: 1, savedAt: "2026-11-27T00:00:00.000Z", savedBy: { kind: "main", provider: "claude", conversationId: "c1" },
    files: [], facts, docs: { run: { summary: "s", body: "", params: [], returns: null, throws: [] }, trigger: null }, parts: [],
    outsideEffects: [{ kind: "file", text: "Reads ~/.agents/skills" }], sourceRequest: { id: "m1", text: "only from 3 on" },
    review: { state: "ok", findings: [], summary: "", model: null, at: "2026-11-27T00:00:00.000Z", acknowledged: null }, preview: null } as AutomationVersion);
  expect(shown.facts.ai.map(row => row.use ?? null)).toEqual(["ask", "task", null, null]);
  // The person's words the coordinator was given, and what it does outside alpacawork.
  expect([shown.savedBy.request, shown.direct]).toEqual(["only from 3 on", [{ kind: "file", text: "Reads ~/.agents/skills" }]]);
});

test("the server's reason kinds are said in words, a limit naming the operation whose limit it met", async () => {
  const { i18n, startI18n } = await import("@alpacawork/i18n");
  startI18n(); await i18n.changeLanguage("en");
  const t = i18n.getFixedT("en", "automations") as never;
  const { reasonText } = await import("../src/features/automations/words");
  expect([reasonText(t, { reasonKind: "limit:tasks.create", reasonText: null }), reasonText(t, { reasonKind: "limit:send", reasonText: null }), reasonText(t, { reasonKind: "timeout", reasonText: "The automation exceeded its time limit" })])
    .toEqual(["Reached the limit of tasks one run may make", "Reached the limit of send", "Stopped at its time limit"]);
});
