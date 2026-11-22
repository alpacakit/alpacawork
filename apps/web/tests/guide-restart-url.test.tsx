import { expect, test } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGuideRestartFromUrl } from "../src/features/guide/use-guide";
import { guideStage } from "../src/features/guide/guide-state";

test("opened with ?guide=restart, the guide starts over from its first screen and the address forgets it", () => {
  guideStage.set({ stage: "done" });
  history.replaceState(null, "", "/?project=P1&guide=restart");
  renderHook(() => useGuideRestartFromUrl());
  expect(guideStage.get()).toMatchObject({ stage: "started", seen: [], intro: true });
  expect(location.search).toBe("?project=P1");
});
