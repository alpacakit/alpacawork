import { act, render } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import { TodayMarks } from "../src/features/analysis/FaceSwitch";
import { FRESH_AFTER_MS } from "../src/features/analysis/data";
import { queryClient } from "../src/data/query-client";
import { screenData, TestWorkspace } from "./fixtures";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("ja"); });
afterEach(() => { vi.useRealTimers(); queryClient.clear(); });

const today = (count: number) => ({
  head: { timeZone: "UTC", today: "2026-11-24", firstDay: "2026-11-01", project: null, period: { from: "2026-11-24", to: "2026-11-24" }, previous: null },
  total: count, cursor: null,
  rows: Array.from({ length: count }, (_, at) => ({ id: `T${at + 1}`, title: "t", project: "P100", outcome: "passed", finishedAt: "2026-11-24T01:00:00Z", value: null })),
});

test("today's marks are read again when the workspace changes while the list stays open", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const answers = [today(1), today(2)];
  const marks = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("analysis/list") ? answers.shift() ?? today(2) : {}), { status: 200 }));
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => marks(String(input)));
  const data = screenData();
  const view = render(<TestWorkspace data={data}><TodayMarks /></TestWorkspace>);
  await vi.waitFor(() => expect(view.container.querySelectorAll("button i")).toHaveLength(1));
  // A change notice: the index moves on, and after the short wait the marks are asked for again.
  view.rerender(<TestWorkspace data={{ ...data, info: { ...data.info, rev: data.info.rev + 1 } }}><TodayMarks /></TestWorkspace>);
  await act(async () => { await vi.advanceTimersByTimeAsync(FRESH_AFTER_MS + 10); });
  await vi.waitFor(() => expect(view.container.querySelectorAll("button i")).toHaveLength(2));
});
