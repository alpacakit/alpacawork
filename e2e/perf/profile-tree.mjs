// Time each stage of serve's tree read (readControlTree) on a measurement root, read-only.
// Usage: node e2e/perf/profile-tree.mjs <root> [rounds]   (after pnpm build)
// Prints one JSON line: per round, milliseconds per stage, the JSON size, the task count and the Tasks' Run count.
import { performance } from "node:perf_hooks";

const dist = new URL("../../apps/backend/dist/", import.meta.url);
const { ControlTaskStore, controlSnapshotView } = await import(new URL("control/task-store.js", dist).href);
const { readControlTree } = await import(new URL("control/tree.js", dist).href);
const { taskFiles } = await import(new URL("control/task-files.js", dist).href);
const { FileWriter } = await import(new URL("raw/storage.js", dist).href);
const { RunStore } = await import("@alpacawork/runs");

const [root, roundsArg] = process.argv.slice(2);
if (!root) throw new Error("Usage: profile-tree.mjs <root> [rounds]");
const rounds = [];
for (let round = 0; round < Number(roundsArg ?? 2); round++) {
  const ms = {};
  const time = async (label, fn) => { const start = performance.now(); const value = await fn(); ms[label] = Math.round(performance.now() - start); return value; };
  const snapshot = await time("taskScanParse", () => new ControlTaskStore(root).snapshot());
  const view = controlSnapshotView(snapshot);
  const store = RunStore.openReadable(root, { busyTimeoutMs: 0 });
  if (!store) throw new Error(`No control database under ${root}`);
  try {
    // The Runs, placements, Requests and returns, in the one read the tree takes them in; the Tasks' Runs are those
    // the coordinators' are not.
    const records = await time("runSnapshot", () => store.snapshot());
    const runs = records.records.filter((run) => run.role !== "coordinator").length;
    await time("taskFiles", () => { const writer = new FileWriter(root); try { return taskFiles(writer, view.tasks.map((task) => task.path)); } finally { writer.close(); } });
    const tree = await time("readControlTreeTotal", () => readControlTree(root, { source: () => store }));
    const json = await time("stringify", () => JSON.stringify(tree));
    rounds.push({ ms, bytes: Buffer.byteLength(json), tasks: tree.tasks.length, runs, errors: tree.errors.length });
  } finally { store.close(); }
}
console.log(JSON.stringify(rounds));
