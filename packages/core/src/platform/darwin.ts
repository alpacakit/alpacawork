import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostAdapter } from './types.js';
import { posixRun } from './posix-process.js';
import { launchdService } from './launchd-service.js';


export const darwinAdapter: HostAdapter = {
  posix: {
    libc: '/usr/lib/libSystem.B.dylib',
  },
  isSandboxed(libc) {
    const result = libc.func('int sandbox_check(int pid, const char *operation, int type)')(process.pid, null, 0);
    if (result === 1) return true;
    if (result === 0) return false;
    throw new Error('Cannot determine whether the caller is sandboxed');
  },
  canDecodeImage(absolute) {
    const scratch = mkdtempSync(join(tmpdir(), 'alpacawork-report-image-'));
    try {
      execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '--out', join(scratch, 'decoded.png'), absolute],
        { timeout: 5000, stdio: 'ignore' });
      return true;
    } catch { return false; }
    finally { rmSync(scratch, { recursive: true, force: true }); }
  },
  folderDialog(start, title) {
    // Finder's chooser; a cancel is AppleScript error -128, which osascript ends with status 1.
    return { command: '/usr/bin/osascript', args: ['-e', 'on run argv',
      '-e', 'POSIX path of (choose folder with prompt (item 2 of argv) default location (POSIX file (item 1 of argv)))',
      '-e', 'end run', start, title] };
  },
  run: posixRun,
  service: launchdService,
};
