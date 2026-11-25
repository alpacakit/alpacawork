import { expect, test } from "vitest";
import { sentText, willResend } from "../src/features/telemetry/sent-text";

// The list shows the sent body laid out to read; it must still say exactly what was sent.
test("the laid-out body holds the same JSON as the bytes sent, one counted action per line", () => {
  const body = JSON.stringify({ schema: 2, id: "x", day: "2026-11-23", events: [["send.button", 13, "phone.android", "screen", "ja", "dark"], ["w.ask", 83, "-", "run.claude", "-", "-"]],
    shape: { tasks: "100+" }, times: { open: ["0.5-1s", "1-2s"] }, agents: ["claude", "codex"] });
  const text = sentText(body);
  expect(JSON.parse(text)).toEqual(JSON.parse(body));
  expect(text.split("\n")).toContain('    ["send.button",13,"phone.android","screen","ja","dark"],');
  expect(sentText("not json")).toBe("not json");
});

// Only a day still waiting is sent again, and only its newest attempt says so.
test("an attempt reads as sent again only while its day is waiting, on the newest attempt of that day", () => {
  const log = [{ kind: "report", day: "2026-11-20" }, { kind: "report", day: "2026-11-20" }, { kind: "report", day: "2026-11-19" }, { kind: "delete" }];
  expect([...willResend(log, new Set(["2026-11-20"]))]).toEqual([log[0]]);
  expect(willResend(log, new Set()).size).toBe(0);
});
