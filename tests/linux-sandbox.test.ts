import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Linux sandbox admission accepts the initial SELinux context without bypassing refusal gates', { skip: process.platform !== 'linux' }, () => {
  const status = 'CapEff:\t0000000000000000\nNoNewPrivs:\t0\nSeccomp:\t0\n';
  const initial = { status, profile: 'kernel\0', uidMap: '         0          0 4294967295\n', euid: 1000 };
  type Inputs = Omit<typeof initial, 'euid'> & { euid: number | null };
  type Case = { name: string; input?: Partial<Inputs>; fault?: { path: string; code: string }; expected: boolean | 'unknown' };
  const cases: Case[] = [
    { name: 'observed WSL inputs', expected: false },
    { name: 'AppArmor unconfined', input: { profile: 'unconfined\n' }, expected: false },
    { name: 'existing unconfined whitespace', input: { profile: ' unconfined\n' }, expected: false },
    { name: 'root', input: { euid: 0 }, expected: true },
    { name: 'strict seccomp', input: { status: status.replace('Seccomp:\t0', 'Seccomp:\t1') }, expected: true },
    { name: 'filtered seccomp', input: { status: status.replace('Seccomp:\t0', 'Seccomp:\t2') }, expected: true },
    { name: 'no new privileges', input: { status: status.replace('NoNewPrivs:\t0', 'NoNewPrivs:\t1') }, expected: true },
    { name: 'effective capability', input: { status: status.replace('0000000000000000', '0000000000000001') }, expected: true },
    { name: 'mapped user namespace', input: { uidMap: '0 100000 65536\n' }, expected: true },
    { name: 'AppArmor enforce', input: { profile: 'kernel (enforce)\n' }, expected: true },
    { name: 'AppArmor complain', input: { profile: 'kernel (complain)\n' }, expected: true },
    { name: 'loaded SELinux kernel domain', input: { profile: 'system_u:system_r:kernel_t:s0\0' }, expected: true },
    { name: 'loaded SELinux unconfined domain', input: { profile: 'unconfined_u:unconfined_r:unconfined_t:s0\0' }, expected: true },
    { name: 'kernel without NUL may be a Smack label', input: { profile: 'kernel' }, expected: true },
    { name: 'kernel with newline', input: { profile: 'kernel\n' }, expected: true },
    { name: 'extra NUL', input: { profile: 'kernel\0\0' }, expected: true },
    { name: 'trailing data', input: { profile: 'kernel\0x' }, expected: true },
    { name: 'trailing newline', input: { profile: 'kernel\0\n' }, expected: true },
    { name: 'leading whitespace', input: { profile: ' kernel\0' }, expected: true },
    { name: 'whitespace before NUL', input: { profile: 'kernel \0' }, expected: true },
    { name: 'embedded NUL', input: { profile: 'ker\0nel\0' }, expected: true },
    { name: 'unknown label', input: { profile: 'future-label\n' }, expected: true },
    { name: 'empty label', input: { profile: '' }, expected: 'unknown' },
    { name: 'whitespace-only label', input: { profile: ' \n\t' }, expected: 'unknown' },
    { name: 'missing geteuid', input: { euid: null }, expected: 'unknown' },
    { name: 'missing seccomp', input: { status: status.replace('Seccomp:\t0\n', '') }, expected: 'unknown' },
    { name: 'missing no new privileges', input: { status: status.replace('NoNewPrivs:\t0\n', '') }, expected: 'unknown' },
    { name: 'missing capabilities', input: { status: status.replace('CapEff:\t0000000000000000\n', '') }, expected: 'unknown' },
    { name: 'malformed status', input: { status: 'invalid status' }, expected: 'unknown' },
    { name: 'empty uid map', input: { uidMap: '' }, expected: 'unknown' },
  ];
  for (const path of ['/proc/self/status', '/proc/self/attr/current', '/proc/self/uid_map'])
    for (const code of ['EACCES', 'EPERM', 'ENOENT'])
      cases.push({ name: `${path} ${code}`, fault: { path, code }, expected: 'unknown' });

  // Replace only OS observations in an owned child; exercise the adapter used by serve.
  const entry = new URL('../packages/core/dist/platform/linux.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs'; import assert from 'node:assert/strict';
    import { syncBuiltinESMExports } from 'node:module';
    const initial = ${JSON.stringify(initial)}, cases = ${JSON.stringify(cases)};
    const originalRead = fs.readFileSync;
    let input, fault;
    fs.readFileSync = (path, ...args) => {
      if (fault?.path === path) throw Object.assign(new Error('injected proc read failure'), { code: fault.code });
      if (path === '/proc/self/status') return input.status;
      if (path === '/proc/self/attr/current') return input.profile;
      if (path === '/proc/self/uid_map') return input.uidMap;
      return originalRead(path, ...args);
    };
    syncBuiltinESMExports();
    const { linuxAdapter } = await import(${JSON.stringify(entry)});
    for (const row of cases) {
      input = { ...initial, ...row.input };
      process.geteuid = input.euid === null ? undefined : () => input.euid;
      fault = row.fault;
      if (row.expected === 'unknown')
        assert.throws(() => linuxAdapter.isSandboxed(), /Cannot determine whether the caller is sandboxed/, row.name);
      else assert.equal(linuxAdapter.isSandboxed(), row.expected, row.name);
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 16_384 });
  assert.equal(child.status, 0, child.stderr);
});
