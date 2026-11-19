/** Descriptor operations shared by the selected host ABI. No domain or path policy belongs here. */
import { platform } from './platform/index.js';
import { createRequire } from 'node:module';
import { getSystemErrorName } from 'node:util';
import { PROBLEM_CODE, Problem, hasCode } from './errors.js';
const abi = platform.posix;
// Static external imports run before the bundled host selection can reject Windows.
const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi');
const libc = koffi.load(abi.libc);
export function isSandboxed(): boolean {
  try { return platform.isSandboxed(libc); }
  catch { throw new Problem(PROBLEM_CODE.unavailable, 'Cannot determine whether the caller is sandboxed', undefined,
    { reason: { kind: 'cannot_determine_whether_caller_sandboxed' } }); }
}
const flockNative = libc.func('int flock(int fd, int operation)');
/** `flock` operations shared by Darwin and Linux `<sys/file.h>`. */
const LOCK_SH = 1, LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
function ioError(operation: string): NodeJS.ErrnoException {
  const errno = koffi.errno(),
    code = getSystemErrorName(-errno);
  return Object.assign(new Error(`${operation}: ${code}`), { code, errno: -errno, syscall: operation });
}
function checked(result: number, operation: string): number {
  if (result < 0) throw ioError(operation);
  return result;
}
/** Creation mode used by DB files. */
export const FILE_MODE = 0o600;
/** Takes the exclusive lock without waiting; false when another holder has it. */
export function tryLock(fd: number): boolean {
  try {
    checked(flockNative(fd, LOCK_EX | LOCK_NB), 'flock');
    return true;
  } catch (error) {
    if (hasCode(error, 'EWOULDBLOCK') || hasCode(error, 'EAGAIN')) return false;
    throw error;
  }
}
/** Takes a shared lock without waiting; multiple readers may hold it. */
export function trySharedLock(fd: number): boolean {
  try {
    checked(flockNative(fd, LOCK_SH | LOCK_NB), 'flock');
    return true;
  } catch (error) {
    if (hasCode(error, 'EWOULDBLOCK') || hasCode(error, 'EAGAIN')) return false;
    throw error;
  }
}
export function unlock(fd: number): void {
  checked(flockNative(fd, LOCK_UN), 'flock');
}
