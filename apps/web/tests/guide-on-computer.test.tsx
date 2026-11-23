import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { GuideBalloon } from "../src/features/guide/Guide";
import { guideStage } from "../src/features/guide/guide-state";
import { Welcome } from "../src/features/tree/Welcome";
import { NARROW_QUERY } from "../src/state/view-store";
import { TestWorkspace } from "./fixtures";

beforeAll(() => startI18n());
afterEach(() => { cleanup(); vi.restoreAllMocks(); act(() => guideStage.set(null)); });

test("at a phone's width the guide shows no balloon and keeps its stage for a computer; the welcome says where it is shown", () => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => ({ ...original(query), matches: query === NARROW_QUERY }));
  const going = { stage: "started", at: 1, seen: [] } as const;
  render(<TestWorkspace><Welcome /><GuideBalloon /></TestWorkspace>);
  expect(document.querySelector("[data-guide-elsewhere]")).toBeNull();
  // The guide begins (on a new person's first look) while the welcome stands.
  act(() => guideStage.set(going));
  expect(document.querySelector("[data-guide-balloon]")).toBeNull();
  expect(document.querySelector("[data-guide-elsewhere]")).not.toBeNull();
  expect(guideStage.get()).toEqual(going);
});
