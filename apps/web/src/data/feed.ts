import { readIndex, serverReadFacts, readScope } from './read-model';
import { useEffect, useRef, useState } from "react";
import { onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchEventSource } from "@microsoft/fetch-event-source";
import { INDEX_HEARTBEAT_MS, projectedIndexSchema, indexPatchSchema, type ProjectedIndexDTO } from "@alpacawork/contract/control";
import { i18n } from "@alpacawork/i18n";
import { ApiError } from "./client";
import { PROBLEM_RULE } from "@alpacawork/core/codes";
import { problemSchema } from "@alpacawork/contract/problem";
import { discardReadResources, indexKey, liveRead, recoverReads, receivePatch, receiveFullIndex, resources } from "./resources";
import { useConnection } from "./connection";
import { receiveServerFacts } from "../state/read-store";
import { later } from "@/lib/later";

/**
 * `connecting`: a subscription is being opened (with or without a held index). `reconnecting`: the last one failed
 * and the next is waiting its turn. `stopped`: retrying cannot help, so none is tried until asked. `failures` counts
 * the tries that failed since the feed was last live or this foreground visit began. Manual retries within a visit
 * retain failures; failures from a suspended page do not certify the current connection.
 */
export type Connection = {
  state: "connecting" | "live" | "reconnecting" | "stopped";
  message: () => string;
  failures: number;
};
const liveMessage = () => i18n.t("workspace.live");
const retryDelays = [1000, 2000, 4000, 8000, 15000];
/**
 * The server writes an idle heartbeat at the shared interval. Two missed beats mean the stream is dead though
 * nothing closed it (a phone's sleep, a changed network, a proxy holding the old connection): subscribe again.
 */
export const SILENT_STREAM_MS = INDEX_HEARTBEAT_MS * 2;
/**
 * A try with no answer yet counts as a failed one for each of these it waits, and is left to get its answer: a server
 * reading a large root answers late, and another try would only ask it to read again.
 */
export const UNANSWERED_TRY_MS = INDEX_HEARTBEAT_MS;
/** A patch that does not follow the held index: subscribe again, without resuming, for the whole index. */
class Gap extends Error {}
/** How long a refresh waits for the whole index before it says it did not come (the progress line says why). */
const REFRESH_LIMIT_MS = 10_000;
export function useWorkspace() {
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  // The disabled query has no fetch to notify this hook. Receipt time makes a new
  // index visible after setQueryData, while Workspace's child store selects its slices.
  const lastReceivedAt = useConnection((state) => state.lastReceivedAt);
  const setConnection = (next: Omit<Connection, "failures">) => {
    if (next.state === "live" && !onlineManager.isOnline()) return;
    const before = useConnection.getState().state;
    useConnection.setState((was) => {
      const patch = { ...next, offline: next.state !== "live", failures: next.state === "live" ? 0 : was.failures };
      return (Object.keys(patch) as (keyof typeof patch)[]).every((key) => Object.is(was[key], patch[key])) ? was : patch;
    });
    if (before !== "live" && next.state === "live") void recoverReads(queryClient).catch(() => {});
  };
  const failed = () => useConnection.setState((was) => ({ failures: was.failures + 1 }));
  const query = useQuery({ ...resources.index(), enabled: false });
  // The next subscription asks for the whole index instead of the changes after the one held.
  const whole = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    // TanStack owns native events. Its default is online until the first event;
    // seed an already-offline visit before accepting any stream receipt.
    if (navigator.onLine === false) onlineManager.setOnline(false);
    if (!queryClient.getQueryData(indexKey)) useConnection.setState({ lastReceivedAt: undefined });
    let failures = 0;
    // When the open stream last carried anything, heartbeats included; null while no stream is open.
    let heardAt: number | null = null;
    const silent = () => heardAt !== null && Date.now() - heardAt >= SILENT_STREAM_MS;
    // When the try waiting for its answer began, and how many of its waits are counted; null while none waits.
    let askedAt: number | null = null;
    let unanswered = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const retry = (error: unknown) => {
      heardAt = null;
      if (error instanceof Gap) throw error;
      if (
        controller.signal.aborted ||
        (error instanceof ApiError &&
          (error.code === "forbidden" || error.code === "invalid_response"))
      )
        throw error;
      const delay = retryDelays[failures++] ?? 30000;
      failed();
      setConnection({
        state: "reconnecting",
        message: () => i18n.t("workspace.reconnecting", { count: delay / 1000 }),
      });
      return delay;
    };
    const invalid = () => new ApiError(() => i18n.t("workspace.invalidResponse"), "invalid_response");
    /**
     * What follows from a receipt draws at once wherever it is read (useSyncExternalStore), and a key cannot interrupt
     * that (https://react.dev/reference/react/useSyncExternalStore): each part goes in a task of its own, after any key
     * waiting. Receipts that come together share them.
     */
    let following = false;
    const followReceipt = (at: number) => {
      if (following) return;
      following = true;
      later(() => {
        following = false;
        const server = serverReadFacts(queryClient);
        if (server) receiveServerFacts(server);
        later(() => useConnection.setState({ lastReceivedAt: at }));
      });
    };
    /**
     * An `index` event replaces the index; a `patch` follows the one before it, key by key. A patch that
     * does not follow (a gap the server would not send) reconnects for the whole index.
     */
    const accept = (event: string, value: unknown) => {
      if (controller.signal.aborted || !onlineManager.isOnline()) return;
      let index: ProjectedIndexDTO | null;
      if (event === "index") {
        const parsed = projectedIndexSchema.safeParse(value);
        if (!parsed.success) throw invalid();
        index = parsed.data;
        index = receiveFullIndex(queryClient, index);
        useConnection.setState((was) => ({ wholes: was.wholes + 1 }));
      } else {
        const parsed = indexPatchSchema.safeParse(value);
        if (!parsed.success) throw invalid();
        index = receivePatch(queryClient, parsed.data);
        if (!index) throw new Gap();
      }
      failures = 0;
      followReceipt(Date.now());
    };
    // A reconnection asks for the changes after the index it holds; the server answers with
    // them, or with the whole index when it no longer has them.
    let resume = !whole.current && !!liveRead(queryClient);
    whole.current = false;
    setConnection({ state: "connecting", message: () => i18n.t("workspace.connecting") });
    async function run() {
      const held = resume ? readIndex(queryClient) : undefined;
      resume = true;
      // Once an event has arrived, the library's own retries resume after it, and may get nothing.
      let resuming = !!held;
      await fetchEventSource("/api/events", {
        signal: controller.signal,
        openWhenHidden: true,
        // The library reads comments without telling; count every chunk the stream carries as heard.
        async fetch(input, init) {
          askedAt = Date.now();
          unanswered = 0;
          let response: Response;
          try { response = await fetch(input, init); } finally { askedAt = null; }
          if (!response.ok || !response.body) return response;
          heardAt = Date.now();
          const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, stream) { heardAt = Date.now(); stream.enqueue(chunk); },
          }));
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        },
        // The library's own retries send the latest event ID under this same (lower-case) name.
        headers: held ? { "last-event-id": `${held.generation}:${held.rev}` } : {},
        async onopen(response) {
          if (controller.signal.aborted || !onlineManager.isOnline()) return;
          if (!response.ok) {
            const problem = problemSchema.safeParse(await response.clone().json().catch(() => null));
            const code = problem.success ? problem.data.error.code : response.status === 403 ? "forbidden" : "http_error";
            const retry = problem.success ? problem.data.error.retry : code === "forbidden" ? PROBLEM_RULE.forbidden.retry : "check";
            throw new ApiError(() => i18n.t("workspace.streamUnavailable"), code, retry);
          }
          if (
            !response.headers
              .get("content-type")
              ?.startsWith("text/event-stream")
          )
            throw new ApiError(() => i18n.t("workspace.invalidStream"), "invalid_response");
          // A resumed stream sends only what changed, which may be nothing: it is live once open.
          if (resuming && !!liveRead(queryClient) && !controller.signal.aborted) {
            failures = 0;
            setConnection({ state: "live", message: liveMessage });
          }
        },
        onmessage(event) {
          if (controller.signal.aborted || !onlineManager.isOnline()) return;
          if (event.event !== "index" && event.event !== "patch") return;
          try {
            accept(event.event, JSON.parse(event.data));
            resuming = true;
          } catch (error) {
            throw error instanceof ApiError || error instanceof Gap
              ? error
              : new ApiError(() => i18n.t("workspace.unreadableUpdate"), "invalid_response");
          }
          if (!controller.signal.aborted) {
            setConnection({
              state: "live",
              message: liveMessage,
            });
          }
        },
        onclose() {
          throw new ApiError(() => i18n.t("workspace.streamClosed"));
        },
        onerror: retry,
      });
    }
    async function connect() {
      try {
        await run();
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof Gap) { resume = false; void connect(); return; }
        try {
          retryTimer = setTimeout(() => void connect(), retry(error));
        } catch {
          if (error instanceof ApiError && error.code === "forbidden") discardReadResources(queryClient);
          setConnection({
            state: "stopped",
            message: () =>
              error instanceof ApiError
                ? error.displayMessage
                : i18n.t("workspace.connectionFailed"),
          });
        }
      }
    }
    const reconnect = () => {
      if (!controller.signal.aborted) {
        // Cancel the old subscription/timer before starting another bootstrap.
        controller.abort();
        clearTimeout(retryTimer);
        setAttempt((value) => value + 1);
      }
    };
    // Every foreground visit checks the current connection. Publish the new observation synchronously, before any
    // queued old callback or display timer can classify this visit using a suspended stream's failures.
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      // An online event may already have scheduled the next subscription. Retiring that transport must not retire
      // this page's foreground observation too: its fresh failures/native sample are needed in either event order.
      reconnect();
      useConnection.setState({ state: "connecting", message: () => i18n.t("workspace.connecting"), offline: true, failures: 0 });
      onlineManager.setOnline(navigator.onLine !== false);
    };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) onVisible(); };
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("resume", onVisible);
    window.addEventListener("pageshow", onPageShow);
    const onOnline = () => { if (onlineManager.isOnline()) reconnect(); };
    const stopOnline = onlineManager.subscribe((online) => {
      if (online) onOnline();
      else {
        // Explicit offline invalidates this subscription immediately, including
        // an open/delta callback already queued by the old stream.
        setConnection({ state: "reconnecting", message: () => i18n.t("workspace.networkError") });
        reconnect();
      }
    });
    window.addEventListener("online", onOnline);
    // A silent stream is noticed here, and at once when the page is shown again (a hidden page's timers are slowed).
    // Here its silence is a failed try, and so is each `UNANSWERED_TRY_MS` a try waits; an aborted feed waits for its
    // successor.
    const watch = setInterval(() => {
      if (controller.signal.aborted) return;
      if (silent()) { failed(); reconnect(); }
      else if (askedAt !== null && Date.now() - askedAt >= (unanswered + 1) * UNANSWERED_TRY_MS) { unanswered++; failed(); }
    }, UNANSWERED_TRY_MS / 2);
    if (onlineManager.isOnline()) void connect();
    else setConnection({ state: "reconnecting", message: () => i18n.t("workspace.networkError") });
    return () => {
      controller.abort();
      setConnection({ state: "connecting", message: () => i18n.t("workspace.connecting") });
      clearTimeout(retryTimer);
      clearInterval(watch);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("resume", onVisible);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      stopOnline();
    };
  }, [attempt, queryClient]);
  useEffect(() => {
    // A refresh is the whole index, by a new subscription that does not resume (what a reload would read, the page kept),
    // and every query on screen read again. A live feed already holds every change, so it is for a stream that may have
    // gone quiet (a phone's sleep, a changed network) and for being sure; it ends when both are in, or says it failed.
    const refresh = () => {
      const before = useConnection.getState().wholes;
      const index = new Promise<boolean>((resolve) => {
        const done = (ok: boolean) => { stop(); clearTimeout(limit); resolve(ok); };
        const stop = useConnection.subscribe((state) => {
          if (state.wholes > before) done(true);
          else if (state.state === "reconnecting" || state.state === "stopped") done(false);
        });
        const limit = setTimeout(() => done(false), REFRESH_LIMIT_MS);
      });
      whole.current = true;
      setAttempt((value) => value + 1);
      const shown = (readScope(queryClient)?.anchored === false ? recoverReads(queryClient) : queryClient.refetchQueries({ type: "active" }, { throwOnError: true })).then(() => true, () => false);
      return Promise.all([index, shown]).then(([one, other]) => one && other);
    };
    useConnection.setState({ reconnect: () => setAttempt((value) => value + 1), refresh });
  }, [queryClient]);
  useEffect(() => {
    // A read scope cut while the feed stays live (a held read let go, a checkpoint handed over) is read again here:
    // the list goes on by patches, but no server fact is current until the index is read again, so the reader would
    // keep drawing the view it had (a Run that ended still at work). Twice per cut at most, since a patch may
    // overtake the first read and leave the scope cut.
    let reading = false, era = -1, tries = 0;
    const anchor = () => {
      const scope = readScope(queryClient);
      if (reading || scope?.anchored !== false || useConnection.getState().state !== "live") return;
      if (scope.era !== era) { era = scope.era; tries = 0; }
      if (tries++ >= 2) return;
      reading = true;
      void recoverReads(queryClient).catch(() => {}).finally(() => { reading = false; anchor(); });
    };
    const stopReads = queryClient.getQueryCache().subscribe((event) => { if (event.query.queryKey[0] === "index") anchor(); });
    const stopConnection = useConnection.subscribe(anchor);
    return () => { stopReads(); stopConnection(); };
  }, [queryClient]);
  return {
    ...query,
    lastReceivedAt,
    reconnect: () => setAttempt((value) => value + 1),
  };
}
