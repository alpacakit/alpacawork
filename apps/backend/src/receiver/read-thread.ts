import { backendEntry } from '../app-paths.js';
/**
 * The address everyone connects to lives on a thread of its own, because the server's main thread holds its event loop
 * for seconds at a time (synchronous SQLite, reconciliation, the tree) and everything waiting for it waits as long.
 * The thread answers a command's plain reads itself, on its own connections, and passes every other connection's bytes
 * to the main thread's listener unread, so nothing else about the service knows it is there.
 */
import { Worker } from 'node:worker_threads';
import { soundControlFile } from '@alpacawork/db';

export type ReadThreadData = { root: string; port: number; publicHost: string | null; backendPort: number; soundFile: string | null;
  /** Off, every connection goes to the main thread: in rollback mode a reader here would wait for the writer's lock, and hold this thread. */
  answers: boolean };
export type ReadThread = { readonly port: number;
  /** No new connection; those under way go on until `close`. */
  stop(): Promise<void>;
  close(): Promise<void> };
const RESTART_MS = 100, RELISTEN_MS = 2_000, FINISH_MS = 2_000;
type Message = { listening: number } | { stopped: true } | { finished: true } | { failed: { message: string; code?: string } };

export function startReadThread(options: Omit<ReadThreadData, 'soundFile'>): Promise<ReadThread> {
  let closing = false, running = false, worker: Worker, stopped: (() => void) | undefined, finished: (() => void) | undefined;
  let port = options.port;
  const thread: ReadThread = {
    get port() { return port; },
    stop() {
      closing = true;
      if (!running) return Promise.resolve();
      return new Promise<void>(done => {
        worker.once('exit', () => done());
        stopped = done;
        worker.postMessage('stop');
      });
    },
    async close() {
      closing = true;
      if (!running) return;
      // An answer under way is not cut off; one that does not finish does not hold the service open.
      await new Promise<void>(done => {
        const deadline = setTimeout(done, FINISH_MS);
        finished = () => { clearTimeout(deadline); done(); };
        worker.once('exit', () => { clearTimeout(deadline); done(); });
        worker.postMessage('finish');
      });
      await worker.terminate();
    },
  };
  return new Promise((resolve, reject) => {
    let started = false, restartIn = RESTART_MS;
    const start = () => {
      // The file was checked before this thread starts: a second integrity check of the whole database would hold every read.
      const workerData: ReadThreadData = { ...options, port, soundFile: soundControlFile(options.root) };
      worker = new Worker(backendEntry('receiver/read-thread-worker'), { workerData });
      running = true;
      worker.on('message', (message: Message) => {
        if ('stopped' in message) { stopped?.(); return; }
        if ('finished' in message) { finished?.(); return; }
        if ('listening' in message) {
          port = message.listening;
          if (!started) { started = true; resolve(thread); }
          return;
        }
        const failure = Object.assign(new Error(message.failed.message), message.failed.code ? { code: message.failed.code } : {});
        if (!started) { closing = true; void worker.terminate(); reject(failure); }
        else {
          // Something took the port in the gap: nothing can reach the service until this thread has it back.
          console.error('The read thread could not listen again', failure);
          restartIn = RELISTEN_MS;
          void worker.terminate();
        }
      });
      worker.on('error', error => { console.error('The read thread failed', error); });
      // Without this thread nothing can reach the service, so it comes back on the same port.
      worker.on('exit', () => {
        running = false;
        if (closing) return;
        if (!started) { reject(new Error('The read thread ended before listening')); return; }
        const wait = restartIn;
        restartIn = RESTART_MS;
        setTimeout(() => { if (!closing) start(); }, wait).unref();
      });
    };
    start();
  });
}
