#!/usr/bin/env node
/** A bounded trial with its own empty workspace; this never reads the production workspace. */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { initializeWorkspace } from '../../apps/backend/test-dist/control/initialize.js';
import { ControlTaskCommands } from '../../apps/backend/test-dist/control/task-commands.js';
import { MODEL, recognizer } from './recognizer.ts';

const APP_PORT = 29472, ASR_PORT = 29473;

const { values } = parseArgs({ options: {
  data: { type: 'string' }, binary: { type: 'string' }, model: { type: 'string' },
  until: { type: 'string' }, host: { type: 'string' },
} });
if (!values.data || !values.binary || !values.model || !values.until || !values.host)
  throw new Error('Usage: trial.ts --data <new trial folder> --binary <qwen_asr> --model <directory> --until <ISO time> --host <tailnet host:9443>');
const deadline = Date.parse(values.until);
if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline - Date.now() > 48 * 3600_000) throw new Error('Choose an end time within 48 hours');
const root = resolve(values.data);
mkdirSync(root, { recursive: true });
const marker = join(root, 'voice-trial.json');
if (!existsSync(marker)) {
  await initializeWorkspace(root);
  // A local inert agent allows a normal composer and the destination chip, without sending text to an AI service.
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: {
    'local-demo': { start: ['/usr/bin/true', '{prompt}'], resume: ['/usr/bin/true', '{session}', '{prompt}'] },
  }, voice: { provider: 'local', endpoint: `http://127.0.0.1:${ASR_PORT}/v1/audio/transcriptions`, model: MODEL, language: 'ja' } }));
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ title: 'Try voice input here', parentId: null,
    body: 'Press the microphone and speak, then press it again to transcribe. Edit the text before sending. Each recording can be up to 60 seconds.\n\nThis trial uses data separate from production. Sending only records the message in the trial and does not call an external AI. Check accuracy, latency, and usability on your device.' })).task;
  writeFileSync(marker, JSON.stringify({ task: task.id, createdAt: new Date().toISOString() }, null, 2));
}
const model = recognizer(resolve(values.binary), resolve(values.model));
await new Promise<void>((resolve, reject) => { model.once('error', reject); model.listen(ASR_PORT, '127.0.0.1', resolve); });
const backend = spawn(process.execPath, [fileURLToPath(new URL('../../apps/backend/dist/backend.js', import.meta.url)),
  '--workspace', root, 'workspace', 'serve', '--port', String(APP_PORT), '--public-host', values.host], { stdio: ['ignore', 'pipe', 'inherit'] });
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  model.closeAllConnections(); model.close();
  backend.kill('SIGTERM');
  // The user service's control group also kills an in-flight decoder and the backend if graceful exit fails.
  setTimeout(() => process.exit(0), 3000).unref();
};
const timer = setTimeout(stop, deadline - Date.now());
process.on('SIGTERM', stop); process.on('SIGINT', stop);
backend.on('error', error => { console.error(error.message); process.exitCode = 1; stop(); });
backend.on('exit', code => { if (code) process.exitCode = 1; clearTimeout(timer); stop(); });
writeFileSync(join(root, 'voice-trial-running.json'), JSON.stringify({ pid: process.pid, backendPid: backend.pid,
  until: values.until, ...JSON.parse(readFileSync(marker, 'utf8')) }, null, 2));
backend.stdout!.on('data', chunk => {
  process.stdout.write(chunk);
  console.log(JSON.stringify({ trial: root, until: values.until, task: JSON.parse(readFileSync(marker, 'utf8')).task }));
});
