// pnpm perf --data-dir <dir> --out-dir <dir> [--rounds 3] [--only copy,synth1000,synth5000] [--timing]
// Measures the copy and the two synthetic roots in <data-dir> one after another (never in
// parallel: they would share the CPU) and writes summary.md beside the raw JSON.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: {
  "data-dir": { type: "string" }, "out-dir": { type: "string" }, rounds: { type: "string", default: "3" },
  only: { type: "string", default: "copy,synth1000,synth5000" }, port: { type: "string", default: "5688" },
  timing: { type: "boolean", default: false },
  "render-counts": { type: "boolean", default: false },
} });
if (!args["data-dir"] || !args["out-dir"]) throw new Error("--data-dir and --out-dir are required");
const dataDir = resolve(args["data-dir"]), outDir = resolve(args["out-dir"]);
// Larger roots get fewer rounds and longer limits: at 5,000 tasks the current serve may not answer at all.
const sets = {
  copy: { rounds: Number(args.rounds), extra: ["--updates", "5", "--interval", "4000"] },
  synth1000: { rounds: 1, extra: ["--updates", "3", "--interval", "10000", "--first-row-timeout", "180000"] },
  synth5000: { rounds: 1, extra: ["--updates", "2", "--interval", "10000", "--listen-timeout", "300000",
    "--tree-timeout", "300000", "--first-row-timeout", "240000"] },
};
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
for (const name of args.only.split(",")) {
  const data = join(dataDir, name);
  if (!sets[name] || !existsSync(data)) throw new Error(`Unknown or missing data set: ${data}`);
  for (let round = 1; round <= sets[name].rounds; round++) {
    const done = spawnSync(process.execPath, [here("run.mjs"), "--data", data, "--label", `${name}-r${round}`,
      "--out-dir", outDir, "--port", args.port, ...(args.timing ? ["--timing"] : []),
      ...(args["render-counts"] ? ["--render-counts"] : []), ...sets[name].extra], { stdio: "inherit" });
    if (done.status !== 0) console.error(`${name} round ${round} exited with ${done.status}`);
  }
}
spawnSync(process.execPath, [here("table.mjs"), outDir], { stdio: "inherit" });
