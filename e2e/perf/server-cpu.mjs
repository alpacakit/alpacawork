// A bounded server CPU measurement on an already sanitised copy-root.mjs copy.
// Usage: node e2e/perf/server-cpu.mjs <source-copy> <output-dir> [streams=0] [seconds=30] [mode=active|idle]
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, appendFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import YAML from 'yaml';
import { tryLock, unlock } from '@alpacawork/core';
import { startServer } from '../../apps/backend/test-dist/receiver/server.js';

const [sourceArg, outputArg, streamArg = '0', secondsArg = '30', mode = 'active'] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error('source copy and output directory required');
const source = realpathSync(sourceArg);
const output = join(realpathSync(dirname(resolve(outputArg))), basename(outputArg)), root = join(output, 'root');
const streams = Number(streamArg), seconds = Number(secondsArg);
if (!Number.isInteger(streams) || streams < 0 || !Number.isInteger(seconds) || seconds < 10 || seconds > 90)
  throw new Error('invalid streams or duration');
if (mode !== 'active' && mode !== 'idle') throw new Error('mode must be active or idle');
if (existsSync(output)) throw new Error(`Output exists: ${output}`);
const watchdog = setTimeout(() => {
  console.error('CPU measurement deadline exceeded');
  process.exit(124);
}, (seconds + 45) * 1000);
if (source.includes('/.pepe-raw') || source.includes('/.alpacawork-raw') || existsSync(join(source, '.alpacawork', 'connection.json')))
  throw new Error('source must be a stopped production copy');
const config = YAML.parse(readFileSync(join(source, 'config.yaml'), 'utf8'));
if (Object.values(config.agents).some(agent => [...agent.start, ...agent.resume].some(word => word !== '/usr/bin/false')))
  throw new Error('source agent commands are not disabled');
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'serve.pid'), String(process.pid));
if (spawnSync('/bin/cp', ['-cR', source, root]).status !== 0) throw new Error('copy failed');
const dbPath = join(root, '.alpacawork', 'runs.sqlite');
const db = new DatabaseSync(dbPath, { readOnly: true });
const running = db.prepare('SELECT id FROM runs WHERE json_extract(record, \'$.state\') = \'running\'').all()
  .map(row => `R${row.id}`);
db.close();
const held = running.map(id => {
  const fd = openSync(join(root, '.alpacawork', 'runs', id, 'manager.lock'), 'a+');
  if (!tryLock(fd)) throw new Error(`Could not hold ${id}`);
  return fd;
});
const port = 5689;
let server, activityTimer, sampleTimer;
const readers = [];
try {
  server = await startServer(root, port, { timing: true });
  const origin = server.url;
  for (let n = 0; n < streams; n++) {
    const controller = new AbortController();
    const response = await fetch(new URL('/api/events', origin), { signal: controller.signal });
    if (!response.ok) throw new Error(`SSE ${response.status}`);
    const reader = response.body.getReader();
    const received = { runDeltas: 0, placementDeltas: 0, error: null };
    const ready = Promise.withResolvers();
    void (async () => {
      const decoder = new TextDecoder();
      let buffered = '', sawIndex = false;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffered += decoder.decode(chunk.value, { stream: true });
          let end;
          while ((end = buffered.indexOf('\n\n')) !== -1) {
            const block = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (!data) continue;
            if (event === 'index') { sawIndex = true; ready.resolve(); }
            if (event === 'delta') {
              const delta = JSON.parse(data);
              if (delta.runs.upsert.some(run => running.includes(run.id) && run.activity?.toolName?.startsWith('Bench-')))
                received.runDeltas++;
              if (delta.placements.upsert.some(placement => placement.runtime.toolName?.startsWith('Bench-')))
                received.placementDeltas++;
            }
          }
        }
        if (!sawIndex) throw new Error('SSE closed before index');
      } catch (error) {
        if (!controller.signal.aborted) { received.error = error; ready.reject(error); }
      }
    })();
    readers.push({ controller, received });
    await ready.promise;
  }
  const latency = [];
  for (let n = 0; n < 1; n++) {
    const before = performance.now();
    const response = await fetch(new URL('/api/workspace/live', origin));
    const data = await response.arrayBuffer();
    latency.push({ ms: Math.round(performance.now() - before), bytes: data.byteLength, status: response.status });
  }
  // Exclude serve's first reconciliation and file-index build. The measured
  // interval represents an already open workspace with running agents.
  await delay(4000);
  const samples = [];
  const sample = () => {
    const cpu = process.cpuUsage();
    samples.push({ at: Date.now(), cpuSeconds: (cpu.user + cpu.system) / 1e6 });
  };
  sample();
  sampleTimer = setInterval(sample, 1000);
  let seq = 0;
  if (mode === 'active') activityTimer = setInterval(() => {
    seq++;
    for (const id of running) {
      const folder = join(root, '.alpacawork', 'runs', id);
      appendFileSync(join(folder, 'stdout.log'), `{"bench":${seq}}\n`);
      writeFileSync(join(folder, 'activity.json'), JSON.stringify({ at: new Date().toISOString(), kind: 'tool_start', toolName: `Bench-${seq}`, doing: null, note: null, context: null, steps: [] }));
    }
    // The manager also commits Run facts at the start/end of a Run. Change a
    // manager PID here to exercise the same SQLite invalidation without making
    // this copy launch a new agent or route a real Task.
    if ((seq === 4 || seq === 7) && running.length) {
      const writer = new DatabaseSync(dbPath);
      try { writer.prepare("UPDATE runs SET record = json_set(record, '$.pids.manager', ?) WHERE id = ?")
        .run(seq, Number(running[0].slice(1))); }
      finally { writer.close(); }
    }
  }, 2000);
  await delay(seconds * 1000);
  clearInterval(activityTimer);
  clearInterval(sampleTimer);
  sample();
  if (mode === 'active') {
    const finalTree = await (await fetch(new URL('/api/workspace/live', origin))).json();
    if (!finalTree.runs.some(run => running.includes(run.id) && run.activity?.toolName?.startsWith('Bench-')) ||
        !finalTree.placements.some(placement => placement.runtime.toolName?.startsWith('Bench-')))
      throw new Error('Active activity did not reach the tree');
  }
  if (mode === 'active' && readers.some(({ received }) => received.error || !received.runDeltas || !received.placementDeltas))
    throw new Error(`Active SSE activity was not delivered: ${JSON.stringify(readers.map(({ received }) => received))}`);
  const deltas = samples.slice(1).map((item, n) => ({ seconds: (item.at - samples[n].at) / 1000,
    cpuSeconds: item.cpuSeconds - samples[n].cpuSeconds })).filter(item => item.seconds > 0);
  const cpuSeconds = samples.at(-1).cpuSeconds - samples[0].cpuSeconds;
  const delivered = readers.map(({ received }) => ({ runDeltas: received.runDeltas, placementDeltas: received.placementDeltas }));
  writeFileSync(join(output, 'result.json'), JSON.stringify({ running: running.length, streams, seconds, mode, delivered,
    tree: latency, cpuSeconds, averagePercent: 100 * cpuSeconds / (samples.at(-1).at - samples[0].at) * 1000,
    peakPercent: Math.max(0, ...deltas.map(item => 100 * item.cpuSeconds / item.seconds)), samples }, null, 2));
  console.log(JSON.stringify({ running: running.length, streams, seconds, mode, delivered, tree: latency, cpuSeconds,
    averagePercent: 100 * cpuSeconds / (samples.at(-1).at - samples[0].at) * 1000,
    peakPercent: Math.max(0, ...deltas.map(item => 100 * item.cpuSeconds / item.seconds)) }));
} finally {
  if (activityTimer) clearInterval(activityTimer);
  if (sampleTimer) clearInterval(sampleTimer);
  for (const { controller } of readers) controller.abort();
  await server?.close();
  for (const fd of held) { unlock(fd); closeSync(fd); }
  rmSync(root, { recursive: true, force: true });
  clearTimeout(watchdog);
}
