/** Bounded, IPC-controlled POSIX holder; never a real service or provider. */
import { closeSync, constants, openSync } from 'node:fs';
import { tryLock, trySharedLock } from '@alpacawork/core';
const [path, mode] = process.argv.slice(2);
if (!path || !['shared', 'exclusive'].includes(mode)) throw Error('Expected lock path and shared|exclusive');
const fd = openSync(path, constants.O_RDONLY);
const locked = (mode === 'shared' ? trySharedLock : tryLock)(fd);
process.send({ locked, pid: process.pid });
if (!locked) { closeSync(fd); process.exit(0); }
const deadline = setTimeout(() => { closeSync(fd); process.exit(1); }, 20_000);
process.once('message', () => { clearTimeout(deadline); closeSync(fd); process.exit(0); });
