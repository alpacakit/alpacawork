import { expect, test } from "vitest";
import { sentText } from "../src/features/telemetry/sent-text";

// The list shows the sent body laid out to read; it must still say exactly what was sent.
test("the laid-out body holds the same JSON as the bytes sent, one counted action per line", () => {
  const body = JSON.stringify({ schema: 2, id: "x", day: "2026-11-23", events: [["send.button", 13, "phone.android", "screen", "ja", "dark"], ["w.ask", 83, "-", "run.claude", "-", "-"]],
    shape: { tasks: "100+" }, times: { open: ["0.5-1s", "1-2s"] }, agents: ["claude", "codex"] });
  const text = sentText(body);
  expect(JSON.parse(text)).toEqual(JSON.parse(body));
  expect(text.split("\n")).toContain('    ["send.button",13,"phone.android","screen","ja","dark"],');
  expect(sentText("not json")).toBe("not json");
});
