/** Byte responses share media types, sandboxing, cache policy and ranges across managed file owners. */
import { fileInline, fileMediaType, fileStreams } from '@alpacawork/contract';
import { checkFileSize, readOpenedFile, type OpenedFile } from '../raw/storage.js';
import { acceptsApiCompression, canCompressApiResponse } from './api-compression.js';

/** Transformed previews and code files have no revision and stay out of the cache. */
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

type FileResponseOptions = {
  download?: boolean;
  supportsRanges?: boolean;
  revision?: string;
  requestedRevision?: string | null;
  acceptEncoding?: string | null;
  ifNoneMatch?: string | null;
  ifRange?: string | null;
  range?: string | null;
};

export function fileRequestOptions(request: Request, query: URLSearchParams): FileResponseOptions {
  return {
    download: query.get('download') === '1',
    requestedRevision: query.get('v'),
    acceptEncoding: request.headers.get('Accept-Encoding'),
    ifNoneMatch: request.headers.get('If-None-Match'),
    ifRange: request.headers.get('If-Range'),
    range: request.headers.get('Range'),
  };
}

type FileResponsePlan = {
  start: number; end: number; status: 200 | 206 | 304 | 416; hasBody: boolean; headers: Record<string, string>;
};

/** The HTTP policy for original bytes, applied only after the caller has authorized the read. */
export function fileResponsePlan(name: string, size: number, options: FileResponseOptions = {}): FileResponsePlan {
  const { download, supportsRanges = fileStreams(name), revision, requestedRevision, ifNoneMatch, ifRange } = options;
  const contentType = fileMediaType(name);
  const headers: Record<string, string> = { ...BYTE_HEADERS };
  const etag = revision === undefined ? undefined : `"${revision}"`;
  if (etag !== undefined) {
    headers.ETag = etag;
    headers['Cache-Control'] = revision === requestedRevision ? 'private, max-age=31536000, immutable' : 'private, no-cache';
    // A private cache must also distinguish different caller claims on the same URL.
    headers.Vary = 'Authorization, X-Alpacawork-Provider, X-Alpacawork-Conversation';
    const compressible = canCompressApiResponse(contentType, size);
    if (compressible) headers.Vary += ', Accept-Encoding';
    if (ifNoneMatch?.trim() === '*' || ifNoneMatch?.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag)) {
      // Hono weakens the ETag when it compresses a body. Mirror it for a bodyless 304.
      if (compressible && acceptsApiCompression(options.acceptEncoding)) headers.ETag = `W/${etag}`;
      return { start: 0, end: -1, status: 304, hasBody: false, headers };
    }
  }
  headers['Content-Type'] = contentType;
  headers['Content-Disposition'] = fileDisposition(name, download);
  headers['Content-Security-Policy'] = SANDBOX;
  if (supportsRanges) headers['Accept-Ranges'] = 'bytes';
  const range = supportsRanges && (ifRange == null || ifRange.trim() === etag) ? options.range ?? undefined : undefined;
  let start = 0, end = size - 1;
  const invalid = (): FileResponsePlan => ({ start: 0, end: -1, status: 416, hasBody: false,
    headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  if (range !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (!match || !match[1] && !match[2]) return invalid();
    if (match[1]) { start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1; }
    else start = Math.max(0, size - Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start || size === 0 ||
      !match[1] && Number(match[2]) === 0) return invalid();
    end = Math.min(end, size - 1);
  }
  if (range !== undefined) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  headers['Content-Length'] = String(end - start + 1);
  return { start, end, status: range === undefined ? 200 : 206, hasBody: size > 0, headers };
}

function bufferedResponse(plan: FileResponsePlan, bytes: Buffer | null): Response {
  const { start, end, status, headers } = plan;
  return new Response(bytes && plan.hasBody ? new Uint8Array(bytes.subarray(start, end + 1)) : null, { status, headers });
}

export function fileOpenedResponse(name: string, file: OpenedFile, max: number, options: FileResponseOptions): Response {
  const request = { ...options, revision: file.revision };
  const plan = fileResponsePlan(name, file.size, request);
  if (!plan.hasBody) {
    checkFileSize(file.size, max);
    return bufferedResponse(plan, null);
  }
  const bytes = readOpenedFile(file.fd, file.size, max);
  // An in-place write can change the length while we read. The revision still comes from the open.
  return bufferedResponse(bytes.length === file.size ? plan : fileResponsePlan(name, bytes.length, request), bytes);
}

export function fileBytesResponse(name: string, bytes: Buffer, options: FileResponseOptions = {}): Response {
  return bufferedResponse(fileResponsePlan(name, bytes.length, options), bytes);
}
