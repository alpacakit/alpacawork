/** Hold SQLite's shared-lock byte range in a separate process. */
import { openSync, closeSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import koffi from 'koffi';
const libc = koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6');
const lseek = libc.func('int64_t lseek(int fd, int64_t offset, int whence)');
const lockf = libc.func('int lockf(int fd, int command, int64_t length)');
const alarm = libc.func('unsigned int alarm(unsigned int seconds)');
// Native expiry also interrupts a blocked lockf call. The optional lifetime keeps fault tests short.
alarm(Number(process.argv[4] ?? 10));
const fd = openSync(process.argv[2]!, 'r+');
try {
  if (Number(lseek(fd, 1073741824, 0)) !== 1073741824 || lockf(fd, 1, 512) < 0)
    throw new Error(`SQLite byte-range lock failed: ${koffi.errno()}`);
  console.log('locked');
  if (process.argv[3] === 'release') await delay(500);
  else for await (const _ of process.stdin) break;
} finally { closeSync(fd); alarm(0); }
