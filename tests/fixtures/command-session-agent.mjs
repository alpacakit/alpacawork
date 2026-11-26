// Synthetic CLI: resident shares its session; commands start their own. One is reparented within the scope.
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const input = await new Promise(done => lines.once('line', line => done(JSON.parse(line)))); lines.close();
const launch = process.argv.slice(2), outputAt = launch[launch.indexOf('-o') + 1];
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
emit({ type: 'thread.started', thread_id: 'synthetic-process-session' });
emit({ type: 'input.taken', id: input.id });
const finish = () => { writeFileSync(outputAt, 'continued after command timeout'); emit({ type: 'turn.completed' }); process.exit(0); };
// The plan is the fixture message at the end of the coordinator startup prompt.
const plan = JSON.parse(input.text.trimEnd().split('\n').at(-1));
const resident = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
const command = spawn('/bin/bash', ['-c', "trap '' TERM; sleep 30 & wait"], { detached: true, stdio: 'ignore' });
const short = spawn('/bin/bash', ['-c', 'sleep 0.1'], { detached: true, stdio: 'ignore' });
short.on('exit', (code, signal) => writeFileSync(plan.short, JSON.stringify({ code, signal })));
const awayScript = `const {spawn}=require('node:child_process');const c=spawn('/bin/bash',['-c','sleep 30'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(plan.away)},String(c.pid));c.unref();`;
const away = spawn(process.execPath, ['-e', awayScript], { stdio: 'ignore' });
away.on('exit', () => writeFileSync(plan.ready, JSON.stringify({ root: process.pid, resident: resident.pid, command: command.pid, short: short.pid })));
setInterval(() => { if (existsSync(plan.finish)) { finish(); } }, 50);
