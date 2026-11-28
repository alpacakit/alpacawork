import { COMPRESSIBLE_CONTENT_TYPE_REGEX, compress } from 'hono/compress';
import { parseAccept } from 'hono/utils/accept';

const encoding = 'gzip';
const threshold = 1024;

export const compressApiResponses = compress({ encoding, threshold });

export function canCompressApiResponse(contentType: string, size: number): boolean {
  return size >= threshold && COMPRESSIBLE_CONTENT_TYPE_REGEX.test(contentType);
}

export function acceptsApiCompression(acceptEncoding: string | null | undefined): boolean {
  if (acceptEncoding == null) return false;
  const accepted = parseAccept(acceptEncoding);
  const explicit = accepted.find(item => item.type.toLowerCase() === encoding);
  return (explicit?.q ?? accepted.find(item => item.type === '*')?.q ?? 0) > 0;
}
