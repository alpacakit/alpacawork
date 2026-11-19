import { recordFailure } from "@/lib/notify";
import { acceptsDiffInput } from "@alpacawork/contract/report-diff";
import type { CodeFile, DiffColours, StructuredDiffDocument, DiffWorkerRequest, DiffWorkerResponse } from "./diff-types";

const DEADLINE_MS = 10_000;
type Pending = { resolve: (value: DiffColours | null) => void; timer: ReturnType<typeof setTimeout>; signal: AbortSignal; abort: () => void };
const pending = new Map<number, Pending>();
let worker: Worker | undefined;
let nextId = 0;
let failed = false;
let listening = false;

function finish(id: number, value: DiffColours | null): void {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  clearTimeout(request.timer);
  request.signal.removeEventListener("abort", request.abort);
  request.resolve(request.signal.aborted ? null : value);
}
function stop(): void { worker?.terminate(); worker = undefined; }
/** The Worker goes, and whatever waits on it keeps its raw text. */
function closeWorker(): void {
  stop();
  for (const id of pending.keys()) finish(id, null);
}
function report(reason: string, cause?: unknown): void {
  recordFailure(new Error(`Diff ${reason}`, { cause }), "diff colours");
}
function fault(reason: string, cause?: unknown): void {
  failed = true;
  closeWorker();
  report(reason, cause);
}
function send(message: DiffWorkerRequest): void {
  try { worker?.postMessage(message); } catch (error) { fault("post-message", error); }
}
function getWorker(): Worker | undefined {
  if (worker || failed) return worker;
  try {
    const current = new Worker(new URL("./diff.worker.ts", import.meta.url), { type: "module" });
    worker = current;
    current.onmessage = ({ data }: MessageEvent<DiffWorkerResponse>) => {
      if (worker !== current || !pending.has(data?.id)) return;
      if (data.reason) report(data.reason, data.cause);
      finish(data.id, data.colours);
    };
    current.onerror = event => { if (worker === current) { event.preventDefault(); fault("worker-error", event); } };
    current.onmessageerror = event => { if (worker === current) fault("message-error", event); };
    if (!listening) {
      listening = true;
      window.addEventListener("pagehide", closeWorker);
    }
    return current;
  } catch (error) { fault("worker-start", error); return undefined; }
}

/** Starts what paints, ahead of the first page asked for (a diff just opened): its colours then come sooner. */
export function startPainting(): void { getWorker(); }

/** One lazy module owns the worker; every failure/cancellation preserves the raw text (a diff's or a whole file's). */
export function highlightDiff(document: StructuredDiffDocument | CodeFile, signal: AbortSignal = new AbortController().signal): Promise<DiffColours | null> {
  if (signal.aborted || failed || !acceptsDiffInput(document.text)) return Promise.resolve(null);
  const current = getWorker();
  if (!current) return Promise.resolve(null);
  const id = ++nextId;
  return new Promise(resolve => {
    const abort = () => {
      finish(id, null);
      send({ kind: "cancel", id });
      if (!pending.size) stop();
    };
    pending.set(id, { resolve, signal, abort, timer: setTimeout(() => fault("timeout"), DEADLINE_MS) });
    signal.addEventListener("abort", abort, { once: true });
    // Covers cancellation triggered during worker construction or listener setup.
    if (signal.aborted) { abort(); return; }
    send({ kind: "highlight", id, document });
  });
}
