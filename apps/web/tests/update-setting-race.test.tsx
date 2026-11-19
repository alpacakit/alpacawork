// The dialog's "show next time" goes through the personal settings' own save, unmocked. A save of the same setting
// under way ends first, its reread and resend included; a choice the save cannot take is said, never dropped silently.
import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { startI18n } from "@alpacawork/i18n";
import { defaultSettings } from "@alpacawork/contract";
import { seedPersonal } from "./read-fixtures";
import { indexOf, tree } from "./fixtures";
import { queryClient } from "../src/data/query-client";
import { receiveFullIndex } from "../src/data/resources";
import { useConnection } from "../src/data/connection";
import { usePersonalSettings } from "../src/data/personal-settings";
import { intentKey, useWriteIntentStore } from "../src/data/write-intent";
import { useToasts } from "../src/lib/notify";
import { problemResponse } from "./problem";
import { approveStart, placeHere, confirmSettingOn, useUpdateLocal } from "../src/features/update/update-state";

const key = intentKey("/fixture", "personal-setting:update.confirm", null);
const confirmation = { candidateId: "c1", version: "0.10.0", runs: 0, requiresNoRuns: false, changes: null, skills: ["alpacawork"], reviewDigest: "a".repeat(64) } satisfies Omit<Parameters<typeof approveStart>[0], "at">;
beforeAll(() => startI18n());
beforeEach(() => { queryClient.clear(); receiveFullIndex(queryClient, indexOf(tree())); useConnection.setState({ state: "live", offline: false });
  useUpdateLocal.setState({ sending: false, confirm: null }); useWriteIntentStore.setState({ entries: {}, unavailable: false }); useToasts.setState({ toasts: [] }); });
afterEach(() => { vi.restoreAllMocks(); usePersonalSettings.setState(usePersonalSettings.getInitialState(), true); });

/** The settings' save held at its first send; later sends answer at once. Update entries answer success. */
function serve(values: Record<string, unknown>) {
  let release!: () => void;
  const writes: { key: string; value: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    if (String(url).includes("settings/set")) {
      const input = JSON.parse(String(init?.body)); writes.push({ key: input.key, value: input.value });
      const answer = () => Response.json({ values: { ...values, [input.key]: input.value }, revision: `r${writes.length + 1}` });
      return writes.length === 1 ? new Promise<Response>((resolve) => { release = () => resolve(answer()); }) : Promise.resolve(answer());
    }
    if (String(url).includes("update/review")) return Promise.resolve(Response.json({ reviewDigest: "a".repeat(64) }));
    return Promise.resolve(Response.json({ opId: JSON.parse(String(init?.body)).opId, terminal: null }));
  });
  return { writes, release: () => release() };
}

for (const [first, chosen] of [[false, true], [true, false]] as const)
  test(`a save of ${first ? "on" : "off"} under way, then ${chosen ? "on" : "off"} confirmed in the dialog: the dialog's choice is what stays`, async () => {
    const values = { ...defaultSettings(), "update.confirm": !first };
    seedPersonal({ root: "/fixture", status: "ready", fresh: true, values, revision: "r1" });
    const http = serve(values);
    const earlier = usePersonalSettings.getState().save("update.confirm", first);
    expect(useWriteIntentStore.getState().entries[key]?.status).toBe("pending");
    expect(confirmSettingOn()).toBe(true);
    await approveStart({ ...confirmation, at: placeHere() }, chosen);
    expect(http.writes).toHaveLength(1);
    http.release();
    await earlier;
    await vi.waitFor(() => expect(usePersonalSettings.getState().values["update.confirm"]).toBe(chosen));
    expect(http.writes).toEqual([{ key: "update.confirm", value: first }, { key: "update.confirm", value: chosen }]);
  });

test("an earlier save of it not known: the dialog's choice cannot be sent, and the person is told so", async () => {
  const values = { ...defaultSettings(), "update.confirm": false };
  seedPersonal({ root: "/fixture", status: "ready", fresh: true, values, revision: "r1" });
  const http = serve(values);
  useWriteIntentStore.setState({ entries: { [key]: { status: "unconfirmed", operationId: "op", transport: "receipt",
    payload: { key: "update.confirm", value: false, expectedRevision: "r0" }, attempt: "a", at: new Date().toISOString() } as never } });
  await approveStart({ ...confirmation, at: placeHere() }, true);
  await vi.waitFor(() => expect(useToasts.getState().toasts.map((toast) => String(toast.text))).toEqual(
    [expect.stringContaining("Confirm before updating")]));
  expect(http.writes).toEqual([]);
});

const hasNotSavedOn = () => useToasts.getState().toasts.some((toast) => String(toast.text).includes("Confirm before updating"));
const unknownOff = { status: "unconfirmed", operationId: "op", transport: "receipt",
  payload: { key: "update.confirm", value: false, expectedRevision: "r1" }, attempt: "a", at: new Date().toISOString() } as never;

test("an earlier off not known may have landed: a later on that matches the old read is still said, not taken as saved", async () => {
  const values = { ...defaultSettings(), "update.confirm": true };
  seedPersonal({ root: "/fixture", status: "ready", fresh: true, values, revision: "r1" });
  const http = serve(values);
  useWriteIntentStore.setState({ entries: { [key]: unknownOff } });
  await approveStart({ ...confirmation, at: placeHere() }, true);
  await vi.waitFor(() => expect(hasNotSavedOn()).toBe(true));
  expect(http.writes).toEqual([]);
});

test("an earlier off refused by a conflict, reread and sent again: the later on waits for that whole save and stays", async () => {
  const values = { ...defaultSettings(), "update.confirm": true };
  seedPersonal({ root: "/fixture", status: "ready", fresh: true, values, revision: "r1" });
  let releaseRead!: (response: Response) => void;
  let reads = 0;
  const writes: boolean[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    if (String(url).includes("settings/set")) {
      const input = JSON.parse(String(init?.body)); writes.push(input.value);
      return Promise.resolve(writes.length === 1 ? problemResponse("conflict")
        : Response.json({ values: { ...values, "update.confirm": input.value }, revision: `r${writes.length + 2}` }));
    }
    if (String(url).endsWith("settings/get")) { reads++; return new Promise<Response>((resolve) => { releaseRead = resolve; }); }
    if (String(url).includes("update/review")) return Promise.resolve(Response.json({ reviewDigest: "a".repeat(64) }));
    return Promise.resolve(Response.json({ opId: JSON.parse(String(init?.body)).opId, terminal: null }));
  });
  const earlier = usePersonalSettings.getState().save("update.confirm", false);
  await approveStart({ ...confirmation, at: placeHere() }, true);
  await vi.waitFor(() => expect(reads).toBe(1));
  releaseRead(Response.json({ values, revision: "r2" }));
  await earlier;
  await vi.waitFor(() => expect(usePersonalSettings.getState().values["update.confirm"]).toBe(true));
  // The earlier off: refused, reread, sent again; only then the later on.
  expect(writes).toEqual([false, false, true]);
  expect(hasNotSavedOn()).toBe(false);
});

test("the earlier save's settled mark cannot be stored: the later choice still ends and is said", async () => {
  const values = { ...defaultSettings(), "update.confirm": true };
  seedPersonal({ root: "/fixture", status: "ready", fresh: true, values, revision: "r1" });
  const http = serve(values);
  const earlier = usePersonalSettings.getState().save("update.confirm", false);
  await approveStart({ ...confirmation, at: placeHere() }, true);
  const realSetItem = Storage.prototype.setItem;
  const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, name, value) {
    if (name === "alpacawork-write-intents-v5") throw new DOMException("synthetic storage full", "QuotaExceededError");
    return realSetItem.call(this, name, value);
  });
  try {
    http.release();
    await earlier;
    await vi.waitFor(() => expect(usePersonalSettings.getState().values["update.confirm"] === true || hasNotSavedOn()).toBe(true));
  } finally { storage.mockRestore(); }
});

test("the 'not saved' notice closes once the earlier save is known and the setting shows the choice (UX 4/6 N1)", async () => {
  const values = { ...defaultSettings(), "update.confirm": false };
  seedPersonal({ root: "/fixture", status: "ready", fresh: true, values, revision: "r1" });
  serve(values);
  useWriteIntentStore.setState({ entries: { [key]: { status: "unconfirmed", operationId: "op", transport: "receipt",
    payload: { key: "update.confirm", value: true, expectedRevision: "r1" }, attempt: "a", at: new Date().toISOString() } as never } });
  await approveStart({ ...confirmation, at: placeHere() }, true);
  await vi.waitFor(() => expect(hasNotSavedOn()).toBe(true));
  // Checked (the settings' own reread, as its row's button does): the earlier on had landed.
  vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({ values: { ...values, "update.confirm": true }, revision: "r2" }));
  useWriteIntentStore.setState({ entries: { [key]: { ...useWriteIntentStore.getState().entries[key]!, status: "confirmed" } } });
  await usePersonalSettings.getState().load("/fixture", true);
  // The live index names that revision too: the read is current now.
  const prior = queryClient.getQueryData<{ rev: number; person: Record<string, unknown> }>(["index"])!;
  receiveFullIndex(queryClient, { ...prior, rev: prior.rev + 1, person: { ...prior.person, settings: "r2" } } as never);
  await vi.waitFor(() => expect(hasNotSavedOn()).toBe(false));
});

test("the notice stays while the setting still shows the other way", async () => {
  const values = { ...defaultSettings(), "update.confirm": false };
  seedPersonal({ root: "/fixture", status: "ready", fresh: true, values, revision: "r1" });
  serve(values);
  useWriteIntentStore.setState({ entries: { [key]: { status: "unconfirmed", operationId: "op", transport: "receipt",
    payload: { key: "update.confirm", value: true, expectedRevision: "r1" }, attempt: "a", at: new Date().toISOString() } as never } });
  await approveStart({ ...confirmation, at: placeHere() }, true);
  await vi.waitFor(() => expect(hasNotSavedOn()).toBe(true));
  useWriteIntentStore.setState({ entries: { [key]: { ...useWriteIntentStore.getState().entries[key]!, status: "conflict" } } });
  seedPersonal({ root: "/fixture", status: "ready", fresh: true, values, revision: "r2" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(hasNotSavedOn()).toBe(true);
});

test("the notice belongs to the read session of the choice: another root's or a later session's value never closes it (technical connection 1/6 M3)", async () => {
  const values = { ...defaultSettings(), "update.confirm": false };
  seedPersonal({ root: "/fixture", status: "ready", fresh: true, values, revision: "r1" });
  serve(values);
  useWriteIntentStore.setState({ entries: { [key]: { status: "unconfirmed", operationId: "op", transport: "receipt",
    payload: { key: "update.confirm", value: true, expectedRevision: "r1" }, attempt: "a", at: new Date().toISOString() } as never } });
  await approveStart({ ...confirmation, at: placeHere() }, true);
  await vi.waitFor(() => expect(hasNotSavedOn()).toBe(true));
  // Another workspace shows "on": not this choice kept.
  seedPersonal({ root: "/other", status: "ready", fresh: true, values: { ...values, "update.confirm": true }, revision: "o1" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(hasNotSavedOn()).toBe(true);
  // Back on the first root, but in a new read session: the watch has ended, so its value closes nothing either.
  useWriteIntentStore.setState({ entries: { [key]: { ...useWriteIntentStore.getState().entries[key]!, status: "confirmed" } } });
  seedPersonal({ root: "/fixture", status: "ready", fresh: true, values: { ...values, "update.confirm": true }, revision: "r2" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(hasNotSavedOn()).toBe(true);
});

test("a later choice that saves ends the earlier choice's notice and watch; an older save ending later says nothing (technical connection 2/6 C2-2)", async () => {
  const values = { ...defaultSettings(), "update.confirm": false };
  seedPersonal({ root: "/fixture", status: "ready", fresh: true, values, revision: "r1" });
  serve(values);
  useWriteIntentStore.setState({ entries: { [key]: { status: "unconfirmed", operationId: "op", transport: "receipt",
    payload: { key: "update.confirm", value: false, expectedRevision: "r0" }, attempt: "a", at: new Date().toISOString() } as never } });
  await approveStart({ ...confirmation, at: placeHere() }, true);
  await vi.waitFor(() => expect(hasNotSavedOn()).toBe(true));
  // The earlier save is refused: the setting is known off. The person now chooses off, which is already kept.
  useWriteIntentStore.setState({ entries: { [key]: { ...useWriteIntentStore.getState().entries[key]!, status: "refused" } } });
  await approveStart({ ...confirmation, at: placeHere() }, false);
  await vi.waitFor(() => expect(hasNotSavedOn()).toBe(false));
  expect(useToasts.getState().toasts).toEqual([]);
});

test("an earlier choice's save that ends late, refused, after a later choice: no notice from the earlier one", async () => {
  const values = { ...defaultSettings(), "update.confirm": true };
  seedPersonal({ root: "/fixture", status: "ready", fresh: true, values, revision: "r1" });
  let release!: () => void;
  const writes: unknown[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    if (String(url).includes("settings/set")) {
      const input = JSON.parse(String(init?.body)); writes.push(input.value);
      if (writes.length === 1) return new Promise<Response>((resolve) => { release = () => resolve(problemResponse("forbidden")); });
      return Promise.resolve(Response.json({ values: { ...values, "update.confirm": input.value }, revision: "r3" }));
    }
    if (String(url).includes("update/review")) return Promise.resolve(Response.json({ reviewDigest: "a".repeat(64) }));
    return Promise.resolve(Response.json({ opId: JSON.parse(String(init?.body)).opId, terminal: null }));
  });
  await approveStart({ ...confirmation, at: placeHere() }, false);   // earlier choice: off, its save held
  await approveStart({ ...confirmation, at: placeHere() }, true);    // later choice: on (already the setting's value)
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(useToasts.getState().toasts.some((toast) => toast.id === "update-confirm-not-saved")).toBe(false);
});
