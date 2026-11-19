/** Own a TCP port without accepting connections; stdin or expiry ends ownership. */
import koffi from 'koffi';
const darwin = process.platform === 'darwin';
const libc = koffi.load(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6');
const socket = libc.func('int socket(int domain, int type, int protocol)');
const bind = libc.func('int bind(int fd, const void *address, uint32_t length)');
const getsockname = libc.func('int getsockname(int fd, _Out_ void *address, _Inout_ uint32_t *length)');
const close = libc.func('int close(int fd)');
const fd = socket(2, 1, 0);
if (fd < 0) throw new Error(`socket failed: ${koffi.errno()}`);
try {
  const address = Buffer.alloc(16);
  if (darwin) { address[0] = 16; address[1] = 2; }
  else address.writeUInt16LE(2);
  address[4] = 127; address[7] = 1;
  if (bind(fd, address, address.length) < 0) throw new Error(`bind failed: ${koffi.errno()}`);
  if (getsockname(fd, address, [address.length]) < 0) throw new Error(`getsockname failed: ${koffi.errno()}`);
  console.log(JSON.stringify({ port: address.readUInt16BE(2) }));
  const watchdog = setTimeout(() => process.exit(1), 90_000);
  try { for await (const _ of process.stdin) { /* Retain ownership until EOF. */ } }
  finally { clearTimeout(watchdog); }
} finally { close(fd); }
