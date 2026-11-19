import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { HostAdapter } from './types.js';
import { linuxRun } from './linux-process.js';
import { systemdService } from './systemd-service.js';

export const linuxAdapter: HostAdapter = {
  posix: {
    libc: 'libc.so.6',
  },
  isSandboxed() {
    try {
      const status = readFileSync('/proc/self/status', 'utf8');
      const seccomp = /^Seccomp:[ \t]*(\d+)$/m.exec(status)?.[1];
      const noNewPrivs = /^NoNewPrivs:[ \t]*(\d+)$/m.exec(status)?.[1];
      const capabilities = /^CapEff:[ \t]*([0-9a-fA-F]+)$/m.exec(status)?.[1];
      // SELinux returns a NUL-terminated initial context before a policy is loaded.
      const rawProfile = readFileSync('/proc/self/attr/current', 'utf8');
      const profile = rawProfile.trim();
      const uidMap = readFileSync('/proc/self/uid_map', 'utf8').trim();
      const euid = process.geteuid?.();
      if (euid !== undefined && seccomp !== undefined && noNewPrivs !== undefined && capabilities && profile && uidMap)
        return euid === 0 || seccomp !== '0' || noNewPrivs !== '0' ||
          !/^0+$/.test(capabilities) || (profile !== 'unconfined' && rawProfile !== 'kernel\0') ||
          !/^0\s+0\s+4294967295$/.test(uidMap);
    } catch { /* An unknown isolation state cannot authorize run control. */ }
    throw new Error('Cannot determine whether the caller is sandboxed');
  },
  canDecodeImage(absolute) {
    try {
      execFileSync('/usr/bin/ffmpeg', ['-v', 'error', '-xerror', '-i', absolute, '-f', 'null', '-'],
        { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch { return false; }
  },
  run: linuxRun,
  service: systemdService,
};
