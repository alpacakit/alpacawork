/** Descriptor operations for checkout tools on Linux and macOS, without native struct layouts. */
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getSystemErrorName } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi');
const darwin = process.platform === 'darwin';
if (!darwin && process.platform !== 'linux') throw new Error(`Unsupported POSIX host: ${process.platform}`);
const libc = koffi.load(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6');
const flock = libc.func('int flock(int fd, int operation)');
const openat = libc.func('int openat(int fd, const char *name, int flags)');
const unlinkat = libc.func('int unlinkat(int fd, const char *name, int flags)');
const fchmodat = libc.func('int fchmodat(int fd, const char *name, unsigned int mode, int flags)');
const NOFOLLOW = darwin ? 0x20 : 0x100, REMOVEDIR = darwin ? 0x80 : 0x200, CLOEXEC = darwin ? 0x1000000 : 0x80000;
export interface FileIdentity { dev: number | bigint; ino: number | bigint }
const same = (a: FileIdentity, b: FileIdentity) => BigInt(a.dev) === BigInt(b.dev) && BigInt(a.ino) === BigInt(b.ino);
const hasCode = (error: unknown, ...codes: string[]) => codes.includes((error as NodeJS.ErrnoException)?.code!);
function ioError(operation: string): NodeJS.ErrnoException {
  const errno = koffi.errno(), code = getSystemErrorName(-errno);
  return Object.assign(new Error(`${operation}: ${code}`), { code, errno: -errno, syscall: operation });
}
function checked(result: number, operation: string): number {
  if (result < 0) throw ioError(operation);
  return result;
}
export function tryLock(fd: number): boolean {
  if (flock(fd, 2 | 4) === 0) return true;
  const error = ioError('flock');
  if (hasCode(error, 'EAGAIN', 'EWOULDBLOCK', 'EACCES')) return false;
  throw error;
}
/** Leave the event loop available for signal forwarding while another process owns control.lock. */
export async function lock(fd: number): Promise<void> {
  while (!tryLock(fd)) await delay(25);
}
export function unlock(fd: number): void { checked(flock(fd, 8), 'flock unlock'); }
function openDirectory(parent: number, name: string, expected?: FileIdentity): number {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | CLOEXEC;
  let fd = openat(parent, name, flags);
  if (fd < 0) {
    const error = ioError('openat');
    if (!hasCode(error, 'EACCES')) throw error;
    // Only directory entries reach here. A substituted link cannot be followed by either operation.
    checked(fchmodat(parent, name, 0o700, NOFOLLOW), 'fchmodat');
    fd = checked(openat(parent, name, flags), 'openat');
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (expected && !same(opened, expected)) throw new Error('test scratch directory identity changed');
    if (opened.uid !== BigInt(process.getuid!())) throw new Error('test scratch directory belongs to another user');
    if ((opened.mode & 0o700n) !== 0o700n) fchmodSync(fd, Number(opened.mode & 0o7777n) | 0o700);
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function empty(fd: number, path: string): void {
  // The path supplies names only. Every mutation stays relative to the opened directory descriptor.
  // A replaced path can give a stale list; ENOENT is harmless and unlisted entries stop rmdir with ENOTEMPTY.
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    try {
      if (entry.isDirectory()) {
        let child: number;
        try { child = openDirectory(fd, entry.name); }
        catch (error) {
          if (!hasCode(error, 'ENOTDIR', 'ELOOP')) throw error;
          checked(unlinkat(fd, entry.name, 0), 'unlinkat');
          continue;
        }
        try { empty(child, join(path, entry.name)); } finally { closeSync(child); }
        checked(unlinkat(fd, entry.name, REMOVEDIR), 'unlinkat directory');
      } else checked(unlinkat(fd, entry.name, 0), 'unlinkat');
    } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
}
/** Never follow links, or restore permissions on files linked outside the private tree. */
export function removeTreeAt(parentPath: string, name: string, expected: FileIdentity): void {
  const path = join(parentPath, name);
  let info;
  try { info = lstatSync(path, { bigint: true }); }
  catch (error) { if (hasCode(error, 'ENOENT')) return; throw error; }
  if (!info.isDirectory() || !same(info, expected)) throw new Error(`test scratch identity changed: ${path}`);
  if (info.uid !== BigInt(process.getuid!())) throw new Error('test scratch directory belongs to another user');
  const parent = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const fd = openDirectory(parent, name, expected);
    try { empty(fd, path); } finally { closeSync(fd); }
    checked(unlinkat(parent, name, REMOVEDIR), 'unlinkat scratch');
  } finally { closeSync(parent); }
}
