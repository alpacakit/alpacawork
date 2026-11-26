/**
 * The screen's side of updates: the one projection it reads (`update/status`, owned by the release Owner) and the
 * person's intents it sends through the existing update entries. Nothing here decides which candidate is valid, fixed or
 * retryable; every place (the gear's mark, the update button, the status line, the confirmation) draws `useUpdateStatus`.
 */
import { queryOptions, useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { updateOperationSchema, updateReviewSchema, updateStatusSchema, type UpdateStatus } from "@alpacawork/contract";
import { i18n } from "@alpacawork/i18n";
import { ApiError, createApi } from "@/data/client";
import { workspaceWriteBasis } from "@/data/connection";
import { usePersonalSettings, visibleSettingValue } from "@/data/personal-settings";
import { intentKey, isLiveWrite, useWriteIntentStore } from "@/data/write-intent";
import { queryClient } from "@/data/query-client";
import { useFrameSelector } from "@/data/workspace-store";
import { captureReadBoundary, readIndex, sameReadSession } from "@/data/read-model";
import { notify, recordFailure, useToasts } from "@/lib/notify";
import { useEffect, useSyncExternalStore } from "react";
import { APP_VERSION } from "@/lib/app-version";

const api = createApi();

/** What a confirmation sends, and what the release Owner's review resumes as it is: the operation's three values. */
type Resume = { opId: string; candidateId: string; reviewDigest: string };
export type { UpdateStatus };
/** New versions are looked for regularly; a switch under way is followed closely; one stopped for a person changes
 * only by what that person does elsewhere, so it is read again now and then. */
const CHECK_MS = 10 * 60_000, FOLLOW_MS = 3_000, ATTENTION_MS = 30_000;
const FOLLOWED = new Set<UpdateStatus["kind"]>(["fetching", "waiting", "applying", "recovering"]);
const NONE: UpdateStatus = { kind: "none" };
/**
 * Until when the status is followed closely whatever it says: a press is answered before the release has started on
 * it, so the status read just after may still show what was before (a failure, the version offered) for a moment.
 */
let followUntil = 0;
/** Pages that exist only to wait for the update (the page it holds): while one is shown, the status is followed closely. */
let waiting = 0;
export function useWaitingForUpdate() {
  useEffect(() => {
    waiting++;
    // The interval in force was chosen before: read now, so the next one is chosen with this page in view.
    void rereadStatus();
    return () => { waiting--; };
  }, []);
}
const AFTER_PRESS_MS = 60_000;
export const updateStatusQuery = (root: string) => queryOptions({
  queryKey: ["update-status", root] as const,
  queryFn: ({ signal }) => api.request("update/status", updateStatusSchema, signal),
  staleTime: 0,
  refetchInterval: (query) => { const kind = query.state.data?.kind;
    // Not read (the serve restarting in a switch, say): asked again soon, not at the next regular check.
    // A version that switches only while no agent works is read as often as one stopped for a person, whatever the count
    // read last: its button comes the moment none works and goes the moment one starts.
    return kind && FOLLOWED.has(kind) || Date.now() < followUntil || waiting > 0 ? FOLLOW_MS
      : kind === "attention" || needsNoRuns(query.state.data) || query.state.status === "error" ? ATTENTION_MS : CHECK_MS; },
  refetchIntervalInBackground: true,
});

const needsNoRuns = (status: UpdateStatus | undefined) => status?.kind === "available" && status.requiresNoRuns;
/** Every copy of the status read again (one per workspace the page has shown; "" before any index). */
const rereadStatus = () => queryClient.invalidateQueries({ queryKey: ["update-status"] });
/**
 * The projection as last read; none until read, and none when it cannot be read (no mark is better than a wrong one).
 * The bar's gear is drawn before the first index, so the root is read from the frame. While an update holds the
 * workspace (its switch not ended), nothing else can be read, the frame never comes, and the status is read alone.
 */
export function useUpdateStatus(): UpdateStatus {
  const root = useFrameSelector((data) => data?.info.root ?? null);
  const status = useQuery(updateStatusQuery(root ?? "")).data ?? NONE;
  // "Done" stays recorded; once this page itself runs that version there is nothing left to load again.
  return status.kind === "done" && status.version === APP_VERSION ? NONE : status;
}

/**
 * Whether an update's switch is under way as the status was last read for the workspace shown: the serve
 * restarts in it, so being out of reach meanwhile is expected. Read from the shared cache, wherever it is drawn.
 */
export function useUpdateSwitching() {
  return useSyncExternalStore((changed) => queryClient.getQueryCache().subscribe(changed), () => {
    // Only the workspace shown now (a status left from another one says nothing of this one's reach).
    const kind = queryClient.getQueryData<UpdateStatus>(updateStatusQuery(readIndex(queryClient)?.root ?? "").queryKey)?.kind;
    // Done just after a press here: the serve restarts into the new version right after saying so.
    return kind === "fetching" || kind === "applying" || kind === "recovering" || kind === "done" && Date.now() < followUntil;
  });
}

/**
 * Whether a start asks first: as the settings row shows it (a save under way counts as its value), and while a save of
 * it is not known to have landed, it asks. Only a setting shown and known as off starts without asking.
 */
export function confirmSettingOn() {
  const state = usePersonalSettings.getState();
  const entry = state.root ? useWriteIntentStore.getState().entries[intentKey(state.root, "personal-setting:update.confirm", null)] : undefined;
  return isLiveWrite(entry?.status) || visibleSettingValue("update.confirm", state) !== false;
}

/**
 * The dialog's "show next time", saved through the personal settings' one save, which lets an earlier save of the same
 * setting end first. When that save does not take it (an earlier save of it not known, settings not read again), the
 * person is told which way to choose again, rather than lose the choice silently.
 */
async function saveConfirmSetting(on: boolean) {
  // A new choice supersedes the last one: its notice and watch end now, and an older save ending later says nothing.
  const mine = ++choices;
  watching?.(); notify.dismiss(NOT_SAVED);
  // The choice belongs to the read session it is made in, captured before its save is awaited.
  const boundary = captureReadBoundary(queryClient), root = usePersonalSettings.getState().root;
  const saved = await usePersonalSettings.getState().save("update.confirm", on);
  if (saved || mine !== choices) return;
  notify.error(on ? i18n.t("panels:update.settingNotSaved.on") : i18n.t("panels:update.settingNotSaved.off"), { id: NOT_SAVED });
  if (root && sameReadSession(queryClient, boundary)) closeOnceKept(on, boundary, root);
}
const NOT_SAVED = "update-confirm-not-saved";
/** Choices of "show next time" made so far; the latest one is the person's current intent. */
let choices = 0;
/** The one "not saved" notice's watcher; a later choice's replaces it. */
let watching: (() => void) | null = null;
/**
 * The "not saved" notice says the choice is not known to be kept. It belongs to the read session the choice was made
 * in: once that session's setting shows the choice with no save of it left open, the notice has nothing left to say and
 * closes. Another session (a restore, another workspace, the reads cleared), a later choice or closing it by hand ends
 * the watch; a value read in another session is never taken as this choice kept.
 */
function closeOnceKept(on: boolean, boundary: ReturnType<typeof captureReadBoundary>, root: string) {
  watching?.();
  const key = intentKey(root, "personal-setting:update.confirm", null);
  const check = () => {
    if (!useToasts.getState().toasts.some((toast) => toast.id === NOT_SAVED) || !sameReadSession(queryClient, boundary)) return stop();
    const state = usePersonalSettings.getState();
    // Only a value the settings' read Owner holds as current proves the choice kept; one still shown from an older read
    // (ready but not fresh) proves nothing yet.
    if (state.root !== root || isLiveWrite(useWriteIntentStore.getState().entries[key]?.status) || state.status !== "ready" || !state.fresh) return;
    if ((visibleSettingValue("update.confirm", state) !== false) !== on) return;
    notify.dismiss(NOT_SAVED); stop();
  };
  const stops = [useWriteIntentStore.subscribe(check), usePersonalSettings.subscribe(check), queryClient.getQueryCache().subscribe(check),
    useToasts.subscribe(check)];
  function stop() { stops.forEach((each) => each()); if (watching === stop) watching = null; }
  watching = stop;
}

const readReview = (candidateId?: string) =>
  api.request(`update/review${candidateId ? `?candidateId=${encodeURIComponent(candidateId)}` : ""}`, updateReviewSchema);
/** Nothing can be started or resumed now (the release keeps why in its logs): said so, to try again later. */
const unavailable = () => new ApiError(() => i18n.t("panels:update.unavailable"), "unavailable", "later", undefined, [], undefined);
/** The operation the screen shows is no longer the one the review is about: read the status again. */
const movedErrors = new WeakSet<object>();
const moved = () => { const error = new ApiError(() => i18n.t("panels:update.changed"), "conflict", "reread", undefined, [], undefined);
  movedErrors.add(error); return error; };

/**
 * Where a confirmation was read: the workspace and its read session. It counts only there; once the page shows another
 * workspace or a new read session (a restore, the reads cleared), it is closed unsent and the status read again.
 */
export type Place = { root: string; boundary: ReturnType<typeof captureReadBoundary> };
export const placeHere = (): Place => ({ root: readIndex(queryClient)?.root ?? "", boundary: captureReadBoundary(queryClient) });
const stillAt = (place: Place) => (readIndex(queryClient)?.root ?? "") === place.root
  && (place.boundary ? sameReadSession(queryClient, place.boundary) : !captureReadBoundary(queryClient));
/** What one confirmation starts: this version, from its review, overwriting the skills it names on this machine. */
export type Confirmation = { at: Place; candidateId: string; version: string; runs: number; requiresNoRuns: boolean; changes: string[] | null;
  skills: string[]; reviewDigest: string };
/** What this screen has under way: the confirmation open, and a press whose answer has not come. */
type Local = { confirm: Confirmation | null; sending: boolean };
export const useUpdateLocal = create<Local>(() => ({ confirm: null, sending: false }));

/** The one sentence a refused press says (each a literal key, so the translations are kept by their extraction). */
const startFailed = () => i18n.t("panels:update.failed");
async function send(work: () => Promise<unknown>, about: string, failed: () => string = startFailed) {
  if (useUpdateLocal.getState().sending) return;
  useUpdateLocal.setState({ sending: true });
  // Followed closely from the press itself: the status may change before the answer comes (a switch restarts the serve).
  followUntil = Date.now() + AFTER_PRESS_MS;
  try { await work(); }
  catch (error) {
    // Not known whether it was taken (no answer within the write's time, the serve restarting in a switch): nothing is
    // said, the status line says what became of it. Otherwise the one sentence for the person; why the release refused
    // stays in the record (and its logs), not on screen.
    if (error instanceof ApiError && error.retry === "check") recordFailure(error, about);
    // The screen's own word that the status moved on (look at the line now) is said; a refusal's reason is not.
    else notify.failure(error, { about, text: failed(), detail: error instanceof Error && movedErrors.has(error) ? i18n.t("panels:update.changed") : "" });
  }
  finally {
    useUpdateLocal.setState({ sending: false });
    followUntil = Date.now() + AFTER_PRESS_MS;
    await rereadStatus();
  }
}
const confirmUpdate = (body: Resume) =>
  api.request("update/confirm", updateOperationSchema, undefined, body, crypto.randomUUID(), workspaceWriteBasis());

/**
 * Start, or go on with, the update to `candidateId`, as its review now says. An operation already started for it is
 * resumed with the same three values (a retry never makes a new one). Otherwise a new one: asked once in the
 * confirmation, or at once when "confirm before updating" is off.
 */
type Shown = Pick<Confirmation, "version" | "runs" | "requiresNoRuns" | "changes">;
async function begin(candidateId: string, shown: Shown, at = placeHere()) {
  const review = await readReview(candidateId);
  if (!stillAt(at)) throw moved();
  if (review.kind !== "ready") throw unavailable();
  if (review.resume) return confirmUpdate(review.resume);
  const confirmation: Confirmation = { at, candidateId, ...shown, skills: review.skills, reviewDigest: review.reviewDigest };
  if (!confirmSettingOn()) return startConfirmed(confirmation);
  useUpdateLocal.setState({ confirm: confirmation });
}
const startConfirmed = (c: Confirmation) => confirmUpdate({ opId: crypto.randomUUID(), candidateId: c.candidateId, reviewDigest: c.reviewDigest });

/** Put off an update waiting for Runs: its operation is cancelled and the same version is offered again. */
export function postponeUpdate(opId: string) {
  return send(() => api.request("update/cancel", updateOperationSchema, undefined, { opId }, crypto.randomUUID(), workspaceWriteBasis()), "update postpone");
}
/** The update button's press: the review first, then the one confirmation (or the start itself). */
export function pressUpdate(status: Extract<UpdateStatus, { kind: "available" }>) {
  return send(() => begin(status.candidateId, { version: status.version, runs: status.runs, requiresNoRuns: status.requiresNoRuns, changes: status.changes }), "update start");
}
/** Try a failed update again: the same operation when the release still holds it, else a new one confirmed anew. */
export function retryUpdate(status: Extract<UpdateStatus, { kind: "failed" }>) {
  // A refusal for working agents is tried again after they ended: this version is the one that needs none.
  return send(() => begin(status.candidateId, { version: status.version, runs: 0, requiresNoRuns: !!status.runConflict, changes: null }), "update start");
}
/** The confirmation's Update: and (only from the dialog) whether to ask next time. */
export function approveStart(c: Confirmation, showNextTime: boolean) {
  useUpdateLocal.setState({ confirm: null });
  // Read in another workspace or session: nothing of it is saved or sent; the person is told and the status re-read.
  if (!stillAt(c.at)) return send(async () => { throw moved(); }, "update start");
  void saveConfirmSetting(showNextTime);
  return send(() => startConfirmed(c), "update start");
}
/**
 * An update that needs attention goes on with the same operation, as the release's review resumes it (its three values
 * as they were). When the review names no such operation, it cannot go on from here: said so, nothing sent.
 */
export function continueUpdate(status: Extract<UpdateStatus, { kind: "attention" }>) {
  return send(async () => {
    const at = placeHere();
    const review = await readReview();
    if (!stillAt(at)) throw moved();
    if (review.kind !== "ready" || !review.resume || review.resume.opId !== status.opId) throw unavailable();
    await confirmUpdate(review.resume);
  }, "update continue", () => i18n.t("panels:update.continueFailed"));
}

/** Whether an update has anything to show: offered, under way, stopped, failed or done (not the latest, not withdrawn). */
export const updateHasNews = (status: UpdateStatus) => status.kind !== "none" && status.kind !== "withdrawn";

/**
 * What keeps this page from loading the new version by itself once an update is done: unsaved work that only lives in
 * the page (the settings' draft). Drafts of the inputs are kept in the browser and come back after loading again.
 */
export const useReloadHolds = create<{ holds: ReadonlySet<string>; hold: (key: string, on: boolean) => void }>((set) => ({
  holds: new Set(),
  hold: (key, on) => set(({ holds }) => {
    if (holds.has(key) === on) return {};
    const next = new Set(holds);
    if (on) next.add(key); else next.delete(key);
    return { holds: next };
  }),
}));

/**
 * Loads the new version by itself once the server runs it, unless unsaved work holds the page; then the update's card
 * offers the reload. Mounted once with the workspace.
 */
export function useReloadWhenUpdated() {
  const status = useUpdateStatus();
  const held = useReloadHolds((state) => state.holds.size > 0);
  useEffect(() => {
    if (status.kind !== "done" || held) return;
    // Said once by the page that loads: a reload takes away the card that said it.
    try { sessionStorage.setItem(UPDATED_KEY, status.version); } catch { /* the page still loads; it only says less */ }
    reloadForVersion();
  }, [status.kind, held]);
  useEffect(() => {
    let to: string | null = null;
    try { to = sessionStorage.getItem(UPDATED_KEY); sessionStorage.removeItem(UPDATED_KEY); } catch { return; }
    if (to === APP_VERSION) notify.info(i18n.t("panels:update.card.done"), { detail: i18n.t("panels:update.resumeHint") });
  }, []);
}
const UPDATED_KEY = "alpacawork:updated-to";

/** The page is opened again by itself for a new version at most once a minute: a page that still does not match says so. */
const VERSION_RELOAD_KEY = "alpacawork:reloaded-for-version";
const VERSION_RELOAD_MS = 60_000;
/** Opens the page again for serve's new version, unless it was just done (the reload did not bring a matching page). */
export function reloadForVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(VERSION_RELOAD_KEY) ?? 0);
    if (Date.now() - last < VERSION_RELOAD_MS) return false;
    sessionStorage.setItem(VERSION_RELOAD_KEY, String(Date.now()));
  } catch { return false; } // No storage to stop a loop with: the person reloads.
  location.reload();
  return true;
}
