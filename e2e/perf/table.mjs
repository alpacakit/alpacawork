// node e2e/perf/table.mjs <out-dir>: one Markdown table from the run.mjs results in <out-dir>
// (rounds of a set are joined with " / "), written to <out-dir>/summary.md and printed.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.argv[2];
if (!outDir) throw new Error("Usage: table.mjs <out-dir>");
const results = readdirSync(outDir).filter((name) => /^[a-z0-9]+-r\d+\.json$/.test(name)).sort()
  .map((name) => JSON.parse(readFileSync(join(outDir, name), "utf8")));
const sets = [...new Set(results.map((result) => result.label.replace(/-r\d+$/, "")))];
const kb = (bytes) => bytes === undefined ? undefined : `${Math.round(bytes / 1024).toLocaleString("en")}KB`;
const ms = (value) => value === undefined || value === null ? undefined : `${value.toLocaleString("en")}ms`;
const pct = (value) => value === undefined ? undefined : `${value}%`;
const rows = [
  ["Task / Run / request count (index omits requests)", (r) => r.server?.tree?.tasks === undefined ? undefined : `${r.server.tree.tasks}・${r.server.tree.runs}・${r.server.tree.requests ?? "—"}`],
  ["Server: reread tree (readControlTree, second pass)", (r) => ms(r.profile?.[1]?.ms?.readControlTreeTotal)],
  ["  Task scan and parse", (r) => ms(r.profile?.[1]?.ms?.taskScanParse)],
  ["Server: time to listen", (r) => ms(r.server?.listenMs)],
  ["Size of /api/workspace/live (initial SSE)", (r) => kb(r.server?.tree?.bytes) ?? r.server?.tree?.failed?.slice(0, 40)],
  ["  On the wire (when gzip is accepted)", (r) => r.server?.tree?.wireBytes === undefined ? undefined : `${kb(r.server.tree.wireBytes)}（${r.server.tree.wireEncoding ?? "uncompressed"}）`],
  ["　requests", (r) => kb(r.server?.tree?.keys?.requests)],
  ["  tasks (log / body / files)", (r) => r.server?.tree?.keys && r.server.tree.taskKeys.log !== undefined ? `${kb(r.server.tree.keys.tasks)}（${kb(r.server.tree.taskKeys.log)}・${kb(r.server.tree.taskKeys.body)}・${kb(r.server.tree.taskKeys.files)}）` : undefined],
  ["  tasks (index rows: stateLog / notice)", (r) => r.server?.tree?.keys && r.server.tree.taskKeys.stateLog !== undefined ? `${kb(r.server.tree.keys.tasks)}（${kb(r.server.tree.taskKeys.stateLog)}・${kb(r.server.tree.taskKeys.notice)}）` : undefined],
  ["　replies", (r) => kb(r.server?.tree?.keys?.replies)],
  ["　runs", (r) => kb(r.server?.tree?.keys?.runs)],
  ["　balls", (r) => kb(r.server?.tree?.keys?.balls)],
  ["　placements", (r) => kb(r.server?.tree?.keys?.placements)],
  ["Response time of /api/workspace/live", (r) => ms(r.server?.tree?.ms)],
  ["Initial: first row", (r) => ms(r.browser?.phases?.initial?.firstRowMs) ?? r.browser?.phases?.initial?.failed],
  ["Initial: total long-task time (maximum)", (r) => r.browser?.phases?.initial?.long ? `${r.browser.phases.initial.long.totalMs}ms（${r.browser.phases.initial.long.maxMs}）` : undefined],
  ["Open task: heading (heavy task via ?task=)", (r) => r.browser?.phases?.openTask ? `${r.browser.phases.openTask.ms}ms（${r.browser.phases.openHeavy?.ms}）` : undefined],
  ["Open task: content (heavy task)", (r) => r.browser?.phases?.openTask?.contentMs === undefined ? undefined : `${r.browser.phases.openTask.contentMs}ms（${r.browser.phases.openHeavy?.contentMs}）`],
  ["History: shown (all Run results ready)", (r) => r.browser?.phases?.tabHistory ? `${r.browser.phases.tabHistory.shownMs}ms（${r.browser.phases.tabHistory.readsDoneMs}）` : undefined],
  ["Search (one character at a time)", (r) => ms(r.browser?.phases?.search?.ms)],
  ["Idle: serve CPU (browser main thread)", (r) => r.browser?.phases?.idle ? `${pct(r.browser.phases.idle.serveCpuPct)}（${pct(r.browser.phases.idle.rendererBusyPct)}）` : undefined],
  ["Update: write to first SSE byte (median)", (r) => ms(r.browser?.phases?.updates?.median?.writtenToFirstByteMs) ?? r.browser?.phases?.updates?.failed?.slice(0, 40)],
  ["Update: last received byte to paint (median)", (r) => ms(r.browser?.phases?.updates?.median?.lastByteToPaintMs)],
  ["Update: write to paint (median)", (r) => ms(r.browser?.phases?.updates?.median?.writtenToPaintMs)],
  ["Update: main-thread time per update (maximum long task)", (r) => r.browser?.phases?.updates?.median ? `${r.browser.phases.updates.median.mainThreadMs}ms（${r.browser.phases.updates.longMaxMs}）` : undefined],
  ["Update: SSE size per update (median)", (r) => kb(r.browser?.phases?.updates?.median?.bytes)],
  ["During updates: serve CPU (browser main thread)", (r) => r.browser?.phases?.updates?.serveCpuPct === undefined ? undefined : `${pct(r.browser.phases.updates.serveCpuPct)}（${pct(r.browser.phases.updates.rendererBusyPct)}）`],
  ["Update: serve CPU time per update", (r) => ms(r.browser?.phases?.updates?.serveCpuMsPerUpdate)],
];
const header = `| Metric | ${sets.join(" | ")} |\n|---|${sets.map(() => "---").join("|")}|`;
const lines = rows.map(([title, value]) => `| ${title} | ${sets.map((set) =>
  results.filter((result) => result.label.replace(/-r\d+$/, "") === set).map((result) => value(result) ?? "—").join(" / ")).join(" | ")} |`);
const commits = [...new Set(results.map((result) => result.commit))].join(", ");
const table = `Measured: ${commits}、${results[0]?.at ?? ""} (" / " in each column separates runs)\n\n${header}\n${lines.join("\n")}\n`;
writeFileSync(join(outDir, "summary.md"), table);
console.log(table);
