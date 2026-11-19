/** Byte responses share media types, sandboxing, cache policy and ranges across managed file owners. */
import { fileInline, fileMediaType, fileStreams } from '@alpacawork/contract';

/** Every managed file's bytes, whatever their sandbox: never cached, never sniffed. */
export const BYTE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } as const;
export const SANDBOX = "sandbox; default-src 'none'";

/** A basename only, with an ASCII fallback and RFC 8187 UTF-8 name; never interpolate untrusted header bytes. */
export function fileDisposition(name: string, download = false): string {
  const basename = name.split(/[\\/]/).at(-1) || 'file';
  const safe = basename.replace(/[\u0000-\u001f\u007f]/g, '_');
  const fallback = safe.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${download || !fileInline(name) ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

const responseHeaders = (name: string, download = false) => ({ 'Content-Type': fileMediaType(name), 'Content-Disposition': fileDisposition(name, download),
  ...BYTE_HEADERS, 'Content-Security-Policy': SANDBOX });

/** One HTTP byte-range contract for streamed Task files and coordinator media, after each route authorizes its read. */
export function fileResponsePlan(name: string, size: number, range: string | undefined, download = false): {
  start: number; end: number; status: 200 | 206 | 416; hasBody: boolean; headers: Record<string, string>;
} {
  let start = 0, end = size - 1;
  const invalid = () => ({ start: 0, end: -1, status: 416 as const, hasBody: false,
    headers: { ...responseHeaders(name, download), 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' } });
  if (range !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (!match || !match[1] && !match[2]) return invalid();
    if (match[1]) { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
    else start = Math.max(0, size - Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start || size === 0 ||
      !match[1] && Number(match[2]) === 0) return invalid();
    end = Math.min(end, size - 1);
  }
  return { start, end, status: range === undefined ? 200 : 206, hasBody: size > 0, headers: {
    ...responseHeaders(name, download), 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes',
    ...(range === undefined ? {} : { 'Content-Range': `bytes ${start}-${end}/${size}` }),
  } };
}

/** `download`: the original saved under its name (`download=1`), whatever a tab could show of it. */
export function fileBytesResponse(name: string, bytes: Buffer, range?: string, download = false): Response {
  if (fileStreams(name)) {
    const { start, end, status, hasBody, headers } = fileResponsePlan(name, bytes.length, range, download);
    return new Response(hasBody ? new Uint8Array(bytes.subarray(start, end + 1)) : null, { status, headers });
  }
  return new Response(new Uint8Array(bytes), { status: 200, headers: responseHeaders(name, download) });
}
