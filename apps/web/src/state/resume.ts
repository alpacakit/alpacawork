import { isCancelledError } from "@tanstack/react-query";
import { retryOf } from "@/data/client";
import { onBackInReach, useConnection } from "@/data/connection";
import { queryClient } from "@/data/query-client";
import { fetchAcceptedResource, resources } from "@/data/resources";
import type { WorkspaceInfo } from "@/data/types";
import { takeInitialShared } from "@/features/coordinator/shared";
import { deviceValue, jsonCodec } from "@/lib/device-storage";
import { replaceStep } from "@/lib/history";
import { addressesIn, setUrlValue, urlValue } from "./screen-settings";
import { useViewStore } from "./view-store";

/**
 * A restart hint only; the live URL remains authoritative. Origin is implicit in device storage. It names tasks and the
 * project by their Task IDs; a hint kept under another key is not read.
 */
const RESUME_KEYS = ["project", "task", "tab", "path", "q", "image", "event"] as const;
type LastNavigation = { root: string; search: string };
const lastNavigation = deviceValue<LastNavigation | null>("alpacawork.navigation.v2", jsonCodec<LastNavigation | null>((value): LastNavigation | null => {
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<LastNavigation>;
  if (typeof saved.root !== "string" || typeof saved.search !== "string" || saved.search.length > 16384) return null;
  const params = new URLSearchParams(saved.search);
  if ([...params.keys()].some(key => !RESUME_KEYS.some(allowed => allowed === key))) return null;
  return { root: saved.root, search: params.toString() };
}), null);
const isRootLaunch = (url: URL) => url.pathname === "/" && !url.search && !url.hash;
/** Screen options (agent, strip, …) do not specify a different place in the list. */
const isListLaunch = (url: URL) => url.pathname === "/" && !url.hash && !RESUME_KEYS.some(key => url.searchParams.has(key));

/** `url` is where the next restart may land; `awaited`: its task is still being looked up. */
export function rememberNavigation(root: string, url: URL, awaited: boolean) {
  const params = new URLSearchParams();
  for (const key of RESUME_KEYS) {
    // An unresolved address is not a restart destination, but the list's chosen project already is.
    if (awaited && ["task", "tab", "path", "image", "event"].includes(key)) continue;
    const value = url.searchParams.get(key);
    if (value !== null) params.set(key, value);
  }
  lastNavigation.set({ root, search: params.toString() });
}

/** A landing waiting for its saved destination to be confirmed. */
export type Resume = {
  /** Whether it still waits: nothing else has shown or written a place since it landed. */
  waiting: () => boolean;
  /** Something else moved: the saved destination no longer applies. */
  cancel: () => void;
  /** Checks the saved destination, now or once the server is in reach. */
  check: () => void;
  /** The screen is gone. */
  stop: () => void;
};

/**
 * A page landing on the list goes to where the last visit stood, if the server still has it. `landed` runs once the URL
 * says where to go (the saved place, or the launch's own when it cannot be confirmed). Null when there is no such wait:
 * the launch names its own place, or no hint was kept for this workspace.
 */
export function resumeLanding(launch: URL, root: string, projects: () => WorkspaceInfo["projects"], landed: () => void): Resume | null {
  const saved = lastNavigation.get();
  if (!isListLaunch(launch) || saved?.root !== root) return null;
  let waiting = true;
  // Sharing also lands at /. Wait for its one startup read, then validate saved addresses against the server.
  const validate = async () => {
    const shared = await takeInitialShared();
    if (!waiting || useConnection.getState().offline) return;
    const url = new URL(launch);
    if (isRootLaunch(launch)) url.search = saved.search;
    else setUrlValue("project", new URLSearchParams(saved.search).get("project"), url);
    // What the hint opens outside its project widens the list when it is shown (`readNavigation`), as any URL does.
    let valid = !shared;
    let projectAvailable = false;
    const project = urlValue("project", url);
    if (project && !projects().some(({ id }) => id === project)) valid = false;
    if (valid) {
      const addresses = addressesIn(url);
      // Validate each destination independently: a refused reader does not invalidate an accepted project.
      const outcomes = await Promise.allSettled(addresses.map(address =>
        fetchAcceptedResource(queryClient, { ...resources.taskView(root, address), staleTime: 0 })));
      // Cancellation and retry-later failures do not establish that the saved destination is invalid.
      if (outcomes.some(result => result.status === "rejected"
        && (isCancelledError(result.reason) || retryOf(result.reason) === 'later'))) return;
      const active = (result: typeof outcomes[number]) => result.status === "fulfilled" && result.value.task.lifecycle === 'active';
      valid = outcomes.every(active);
      projectAvailable = !!project && outcomes.some((result, at) => addresses[at] === project && active(result));
    }
    if (!waiting) return;
    waiting = false;
    // An unavailable reader/branch must not discard a still-listed project. A pending share owns its launch.
    const listedProject = project && projects().some(({ id }) => id === project) ? project : null;
    const destination = valid && (!project || listedProject) ? url : new URL(launch);
    if (projectAvailable && listedProject) setUrlValue("project", listedProject, destination);
    if (location.href === launch.href && !useViewStore.getState().queryEditedBeforeNavigation) replaceStep(history.state, destination);
    landed();
  };
  // A checkpoint can draw this frame before the stream is reachable. Resume is a read consumer too:
  // wait on the feed's existing lifecycle, never turn its offline cancellation into an invalid hint.
  let checking = false, reachChanged = false;
  const check = () => {
    if (!waiting || useConnection.getState().offline) return;
    if (checking) { reachChanged = true; return; }
    checking = true;
    void validate().finally(() => {
      checking = false;
      if (reachChanged) { reachChanged = false; check(); }
    });
  };
  const offReach = onBackInReach(check);
  return {
    waiting: () => waiting,
    cancel: () => { waiting = false; },
    check,
    stop: () => { waiting = false; offReach(); },
  };
}
