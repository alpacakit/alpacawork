/** Synthetic local agent: a bounded detached command remains in its manager's Linux scope. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
const [root] = process.argv.slice(2);
const lines = createInterface({ input: process.stdin });
const input = await new Promise(done => lines.once('line', line => done(JSON.parse(line)))); lines.close();
const prompt = input.text;
const launch = process.argv.slice(2), outputAt = launch[launch.indexOf('-o') + 1];
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
emit({ type: 'thread.started', thread_id: 'synthetic-process-session' });
emit({ type: 'input.taken', id: input.id });
const finish = () => { writeFileSync(outputAt, 'synthetic reply'); emit({ type: 'turn.completed' }); process.exit(0); };
const { id } = JSON.parse(prompt);
const away = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30_000)', root], { detached: true, stdio: 'ignore' });
await once(away, 'spawn');
away.unref();
const path = join(root, `${id}-unit.json`);
writeFileSync(path + '.tmp', JSON.stringify({ agent: process.pid, away: away.pid,
  scope: readFileSync('/proc/self/cgroup', 'utf8') }));
renameSync(path + '.tmp', path);
setTimeout(() => process.exit(2), 30_000);
setInterval(() => { if (existsSync(join(root, `${id}-finish`))) { finish(); } }, 20);
