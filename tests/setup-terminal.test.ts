import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('setup terminal owns the foreground controlling terminal and preserves confirmation input', { skip: process.platform !== 'linux' && '/proc terminal identity' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'setup-terminal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const answer of ['enter', 'yes', 'YES', 'no', 'cancel', 'eof'] as const) {
    const home = join(root, answer); mkdirSync(home);
    const config = join(root, answer + '.json'), output = join(root, answer + '-result.json');
    const raw = ['yes', 'YES', 'no'].includes(answer);
    const code = `import assert from 'node:assert/strict';import {closeSync,openSync,readFileSync,writeFileSync} from 'node:fs';
assert.equal(process.stdin.isTTY,true);assert.equal(process.stdout.isTTY,true);assert.equal(process.stderr.isTTY,true);
closeSync(openSync('/dev/tty','r+'));
const fields=readFileSync('/proc/self/stat','utf8').split(') ')[1].split(' ');
assert.equal(Number(fields[2]),process.pid);assert.equal(Number(fields[3]),process.pid);assert.equal(Number(fields[5]),process.pid);
writeFileSync(process.env.HOME+'/proof','端末',{mode:0o640});
if (${raw}) process.stdin.setRawMode(true);
console.log(${JSON.stringify(raw ? 'Continue? [Y/n]' : 'Enter to start / Ctrl-C to cancel')});
process.stdin.once('data',bytes=>{process.stdin.pause();if (${raw}) {process.stdin.setRawMode(false);assert.equal(bytes.toString(),${JSON.stringify({ yes: 'y', YES: 'Y', no: 'n' }[answer as 'yes' | 'YES' | 'no'] ?? '')});}console.log('entered')});process.stdin.once('end',()=>console.log('eof'));`;
    writeFileSync(config, JSON.stringify({ home, cwd: root, env: { HOME: home, PATH: '/usr/bin:/bin' }, output, answer, umask: 0,
      command: [process.execPath, '--input-type=module', '-e', code] }));
    const child = spawnSync(process.execPath, [join(import.meta.dirname, 'helpers/setup-terminal.ts'), config], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(result.status, answer === 'cancel' ? -2 : 0, result.transcript);
    assert.equal(result.confirmations, 1);
    assert.deepEqual(result.protectedChanges.map((change: { path: string }) => change.path), ['proof']);
    assert.equal(result.protectedChanges[0].atPrompt[1] & 0o777, 0o640);
    if (answer === 'enter' || raw) assert.match(result.transcript, /entered/);
    if (answer === 'eof') assert.match(result.transcript, /eof/);
  }
});

test('setup tracing detaches without glibc pidfd wrappers and rejects pre-approval runtime writes', { skip: process.platform !== 'linux' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'setup-trace-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), config = join(root, 'config.json'), output = join(root, 'result.json');
  const preload = join(root, 'old-glibc.mjs'), observed = join(root, 'native-loads');
  const runtime = '.local/share/alpacawork/releases/.updates', state = join(home, runtime, 'state.json');
  mkdirSync(join(home, runtime), { recursive: true }); writeFileSync(state, '{}');
  writeFileSync(preload, `import esm from ${JSON.stringify(new URL('../node_modules/koffi/index.js', import.meta.url).href)};
import {createRequire} from 'node:module';import {appendFileSync} from 'node:fs';
const cjs=createRequire(${JSON.stringify(new URL('../package.json', import.meta.url).href)})('koffi');
for(const koffi of new Set([esm,cjs])){const load=koffi.load.bind(koffi);koffi.load=(...args)=>{
appendFileSync(${JSON.stringify(observed)},'loaded\\n');const lib=load(...args);return {func:(...args)=>{
if(/pidfd_(open|send_signal)/.test(String(args[0])))throw Error('glibc lacks pidfd wrappers');
const native=lib.func(...args);if(/\\bsyscall\\(/.test(String(args[0])))return (...words)=>{
if(words.length!==7)throw Error('syscall ABI requires the number and all six argument words');return native(...words);};return native;}};};}
`);
  writeFileSync(config, JSON.stringify({ home, cwd: root, env: { HOME: home, PATH: '/usr/bin:/bin' }, output,
    answer: 'enter', runtimeOwnedRoots: [runtime], trace: { prefix: join(root, 'trace'), paths: [] },
    command: [process.execPath, '--input-type=module', '-e',
      `import {readFileSync,writeFileSync} from 'node:fs';const state=${JSON.stringify(state)};
writeFileSync(state,readFileSync(state));console.log('Enter to start / Ctrl-C to cancel');process.stdin.once('data',()=>process.stdin.pause());`] }));
  const child = spawnSync(process.execPath, ['--import', preload, join(import.meta.dirname, 'helpers/setup-terminal.ts'), config],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /CLI wrote live runtime files before Enter/);
  assert.match(readFileSync(observed, 'utf8'), /loaded/);
  const result = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(result.status, 0, result.transcript);
  assert.equal(result.confirmations, 1);
  assert.equal(result.cliWriteTrace.stoppedBeforeEnter, true);
  assert.deepEqual(result.protectedChanges, [], 'a same-byte write cannot be caught by the HOME snapshot');
  assert(result.cliBeforeEnterWrites.some((write: { syscall: string }) => write.syscall.includes(state) && write.syscall.includes('O_WRONLY')));
});
