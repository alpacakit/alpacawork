/**
 * A file's bytes as the words they hold, or null where they are not text: they hold a NUL byte (as git tells a binary
 * file), or they are neither UTF-8 nor Shift_JIS. UTF-8 wins when valid; a UTF-8 BOM declares it, even for a broken
 * body. Nothing is decoded with replacement characters, so a file that is not text is never shown as garbled lines.
 */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  const utf8Bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  for (const encoding of utf8Bom ? ["utf-8"] : ["utf-8", "shift_jis"]) {
    // With a supported encoding and a Uint8Array, decode's failure is invalid input bytes.
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
    catch { /* Try the next supported encoding. */ }
  }
  return null;
}
