// A value still shown from an older read (ready but not fresh) never proves the dialog's choice kept; the "not saved"
// notice stays until the settings' read Owner holds a current value that is the choice.
import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { defaultSettings } from "@alpacawork/contract";
import { startI18n } from "@alpacawork/i18n";
import { queryClient } from "../src/data/query-client";
import { usePersonalSettings } from "../src/data/personal-settings";
import { receiveFullIndex } from "../src/data/resources";
import { useWriteIntentStore } from "../src/data/write-intent";
import { useConnection } from "../src/data/connection";
import { approveStart, placeHere, useUpdateLocal } from "../src/features/update/update-state";
import { useToasts } from "../src/lib/notify";
import { seedPersonal } from "./read-fixtures";

const confirmation = { candidateId: "c1", version: "0.10.0", runs: 0, requiresNoRuns: false, changes: null, skills: ["alpacawork"], reviewDigest: "a".repeat(64) } satisfies Omit<Parameters<typeof approveStart>[0], "at">;
beforeAll(() => startI18n());
beforeEach(() => { useToasts.setState({ toasts: [] }); queryClient.clear(); useWriteIntentStore.setState({ entries: {}, unavailable: false });
  useUpdateLocal.setState({ sending: false, confirm: null }); });
afterEach(() => { useToasts.setState({ toasts: [] }); useConnection.setState({ state: "live", offline: false }); vi.restoreAllMocks(); });
const hasNotice = () => useToasts.getState().toasts.some((toast) => toast.id === "update-confirm-not-saved");

for (const mode of ["newer settings named by the index", "out of reach"] as const)
  for (const value of [false, true])
    test(`a choice the save cannot take while the settings shown are not current (${mode}, ${value ? "on" : "off"}): the notice stays`, async () => {
      seedPersonal({ root: "/fixture", values: { ...defaultSettings(), "update.confirm": value }, revision: "r1" });
      if (mode === "newer settings named by the index") {
        const prior = queryClient.getQueryData<{ rev: number; person: Record<string, unknown> }>(["index"])!;
        receiveFullIndex(queryClient, { ...prior, rev: prior.rev + 1, person: { ...prior.person, settings: "r2" } } as never);
      } else useConnection.setState({ state: "reconnecting", offline: true, fresh: false });
      const before = usePersonalSettings.getState();
      expect(before.status).toBe("ready");
      expect(before.fresh).toBe(false);
      vi.spyOn(globalThis, "fetch").mockImplementation((url) => Promise.resolve(Response.json(String(url).includes("update/review") ? { reviewDigest: "a".repeat(64) } : { opId: "op", terminal: null })));
      await approveStart({ ...confirmation, at: placeHere() }, value);
      await vi.waitFor(() => expect(hasNotice()).toBe(true));
      queryClient.setQueryData(["unrelated-event"], 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(hasNotice()).toBe(true);
    });
