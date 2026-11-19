/** Linux pidfds through the kernel ABI, independent of glibc's optional convenience wrappers. */
import { createRequire } from 'node:module';

export function linuxPidfd() {
  const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi');
  // glibc x86_64 reads all six argument words, including a stack slot. Reserve that slot in Koffi.
  const syscall = koffi.load('libc.so.6').func('long syscall(long number, long a1, long a2, long a3, long a4, long a5, long a6)');
  // Linux x86_64 and asm-generic (aarch64) use the same pidfd syscall numbers.
  return {
    open: (pid: number, flags: number): number => Number(syscall(434, pid, flags, 0, 0, 0, 0)),
    send: (fd: number, signal: number, _info: null, flags: number): number =>
      Number(syscall(424, fd, signal, 0, flags, 0, 0)),
    errno: koffi.errno,
  };
}
