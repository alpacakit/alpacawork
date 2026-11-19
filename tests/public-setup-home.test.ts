/** The live backend's immutable identity publication is separate from setup-owned HOME writes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

test('setup before-Enter observation only exempts the live backend identity publisher scratch', { skip: process.platform !== 'linux' && 'strace and /proc write tracing' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-setup-home-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = 'alpacawork/.alpacawork/execution-identity.json';
  const scratch = 'alpacawork/.alpacawork/tmp-c85b21c0-7f37-4a82-80d6-6cb35a7fe636';
  const bytes = JSON.stringify({ protocol: 1, workspaceId: '0d6d67a0-a7cf-4221-aaa0-5e37770cf01e' });
  const scenarios = [
    { live: true, path: scratch, bytes, mode: 0o600, protected: false },
    { live: false, path: scratch, bytes, mode: 0o600, protected: true },
    { live: true, path: scratch, bytes: 'setup wrote something else', mode: 0o600, protected: true },
    { live: true, path: scratch, bytes, mode: 0o644, protected: true },
    { live: true, path: 'alpacawork/.alpacawork/tmp-not-a-publisher', bytes, mode: 0o600, protected: true },
    { live: true, path: 'alpacawork/.alpacawork/installation.json', bytes, mode: 0o600, protected: true },
    { live: true, path: identity, bytes: bytes + ' ', mode: 0o600, protected: true },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const home = join(root, String(index)); mkdirSync(join(home, 'alpacawork/.alpacawork'), { recursive: true });
    writeFileSync(join(home, identity), bytes, { mode: 0o600 });
    const output = join(root, `result-${index}.json`), config = join(root, `config-${index}.json`);
    // Actual PTY snapshots surround this child write, just as for the packaged CLI.
    const command = [process.execPath, '--input-type=module', '-e', `import {openSync,writeSync,closeSync} from 'node:fs';
const fd=openSync(process.argv[1],'w',Number(process.argv[3]));writeSync(fd,process.argv[2]);closeSync(fd);
console.log('Enter to start / Ctrl-C to cancel');process.stdin.once('data',()=>process.stdin.pause());`, join(home, scenario.path), scenario.bytes, String(scenario.mode)];
    writeFileSync(config, JSON.stringify({ home, cwd: root, env: { PATH: '/usr/bin:/bin' }, output, answer: 'enter',
      runtimeOwnedPublications: scenario.live ? [identity] : [], trace: { prefix: join(root, `trace-${index}`) }, command }));
    const child = spawnSync(process.execPath, [join(import.meta.dirname, 'helpers/setup-terminal.ts'), config], { encoding: 'utf8' });
    assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, [0, 2, 3].includes(index) ? 1 : 0, child.stderr);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(result.prompt, true); assert.equal(result.status, 0);
    assert.equal(result.beforeEnterChanges.length, 1, 'the real pre-confirmation write was observed');
    assert.equal(result.protectedChanges.length, scenario.protected ? 1 : 0, JSON.stringify(scenario));
    if (index === 0) assert.ok(result.cliBeforeEnterWrites?.length > 0, 'CLI same-bytes scratch must fail the real caller audit');
  }
  for (const [writer, diagnostic] of [['cli-deletes', false], ['cli-child-deletes', false], ['backend', false], ['cli-stays', true], ['cli-deletes', true], ['backend', true]] as const) {
    const key = writer + (diagnostic ? '-diagnostic' : '-normal');
    const home = join(root, key); mkdirSync(join(home, 'alpacawork/.alpacawork'), { recursive: true });
    writeFileSync(join(home, identity), bytes, { mode: 0o600 });
    const output = join(root, `${key}.json`), config = join(root, `${key}-config.json`), socket = join(root, 'backend.sock');
    let backend: ReturnType<typeof spawn> | undefined;
    let backendExit: Promise<unknown[]> | undefined;
    try {
      let code: string;
      if (writer === 'backend') {
        // A separate real child of the test, outside the CLI/strace process tree.
        backend = spawn(process.execPath, ['--input-type=module', '-e', `import {createServer} from 'node:net';import {writeFileSync} from 'node:fs';
const server=createServer(s=>s.once('data',()=>{writeFileSync(process.argv[2],process.argv[3],{mode:0o600});s.end('done');server.close()}));
server.listen(process.argv[1],()=>console.log('ready'));setTimeout(()=>process.exit(2),120000).unref();`, socket, join(home, scratch), bytes]);
        backendExit = once(backend, 'close');
        await once(backend.stdout!, 'data');
        code = `import {createConnection} from 'node:net';import {once} from 'node:events';import assert from 'node:assert/strict';
const socket=createConnection(process.argv[3]);await once(socket,'connect');socket.write('go');
assert.equal((await once(socket,'data'))[0].toString(),'done');socket.end();`;
      } else {
        const write = `import {openSync,writeSync,closeSync,unlinkSync} from 'node:fs';
const fd=openSync(process.argv[1],'wx',0o600);writeSync(fd,process.argv[2]);closeSync(fd);` + (writer === 'cli-stays' ? '' : 'unlinkSync(process.argv[1]);');
        code = writer === 'cli-child-deletes'
          ? `import {execFileSync} from 'node:child_process';execFileSync(process.execPath,['--input-type=module','-e',${JSON.stringify(write)},process.argv[1],process.argv[2]]);` : write;
      }
      code += `
console.log('Enter to start / Ctrl-C to cancel');process.stdin.once('data',()=>process.stdin.pause());`;
      writeFileSync(config, JSON.stringify({ home, cwd: root, env: { PATH: '/usr/bin:/bin' }, output, answer: 'enter',
        runtimeOwnedPublications: [identity], trace: { prefix: join(root, key + '-trace'), paths: diagnostic ? ['alpacawork/.alpacawork/alpacawork.sqlite'] : [] },
        command: [process.execPath, '--input-type=module', '-e', code, join(home, scratch), bytes, socket] }));
      const child = spawnSync(process.execPath, [join(import.meta.dirname, 'helpers/setup-terminal.ts'), config], { encoding: 'utf8' });
      assert.equal(child.error, undefined); assert.equal(child.status, writer === 'backend' ? 0 : 1, child.stderr);
      const result = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(result.prompt, true); assert.equal(result.status, 0);
      assert.deepEqual(result.protectedChanges, []);
      assert.equal(result.cliBeforeEnterWrites?.length > 0, writer !== 'backend', writer);
      assert.equal(result.cliWriteTrace.stoppedBeforeEnter, true);
      t.diagnostic(JSON.stringify({ key, status: child.status, trace: result.cliWriteTrace, writes: result.cliBeforeEnterWrites }));
      if (backendExit) assert.deepEqual(await backendExit, [0, null]);
    } finally {
      if (backend && backend.exitCode === null) { backend.kill(); await backendExit; }
    }
  }
});
