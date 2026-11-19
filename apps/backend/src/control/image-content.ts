/** Container completeness is independent of native decoders, which may accept truncated input. */
import { readFileSync } from 'node:fs';
import { platform } from '@alpacawork/core';

function jpegComplete(data: Buffer): boolean {
  let offset = 2, scanned = false;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) return false;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === undefined) return false;
    if (marker === 0xd9) return scanned;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (marker === 0x00 || marker === 0xd8 || offset + 2 > data.length) return false;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return false;
    offset += length;
    if (marker !== 0xda) continue;
    scanned = true;
    while (offset < data.length) {
      if (data[offset] !== 0xff) { offset++; continue; }
      const next = data[offset + 1];
      if (next === undefined) return false;
      if (next === 0x00 || next >= 0xd0 && next <= 0xd7) { offset += 2; continue; }
      break;
    }
  }
  return false;
}

function gifComplete(data: Buffer): boolean {
  if (data.length < 14 || !['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6)) ||
    !data.readUInt16LE(6) || !data.readUInt16LE(8)) return false;
  let offset = 13 + (data[10]! & 0x80 ? 3 * 2 ** ((data[10]! & 7) + 1) : 0), images = 0;
  const blocks = () => {
    while (offset < data.length) {
      const length = data[offset++]!;
      if (!length) return true;
      offset += length;
      if (offset > data.length) return false;
    }
    return false;
  };
  while (offset < data.length) {
    const marker = data[offset++];
    if (marker === 0x3b) return images > 0 && offset === data.length;
    if (marker === 0x21) { // Extension label followed by complete sub-blocks.
      if (offset >= data.length) return false;
      offset++;
      if (!blocks()) return false;
    } else if (marker === 0x2c) {
      if (offset + 9 > data.length || !data.readUInt16LE(offset + 4) || !data.readUInt16LE(offset + 6)) return false;
      const packed = data[offset + 8]!;
      offset += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      if (offset >= data.length || data[offset]! < 2 || data[offset]! > 8) return false;
      offset++;
      if (!blocks()) return false;
      images++;
    } else return false;
  }
  return false;
}

function pngComplete(data: Buffer): boolean {
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8, pixels = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8);
    if (offset === 8 && (type !== 'IHDR' || length !== 13)) return false;
    offset += length + 12;
    if (offset > data.length) return false;
    if (type === 'IDAT') pixels = true;
    if (type === 'IEND') return length === 0 && pixels && offset === data.length;
  }
  return false;
}

function avifComplete(data: Buffer): boolean {
  let offset = 0, brand = false, metadata = false, pixels = false;
  while (offset + 8 <= data.length) {
    let size = data.readUInt32BE(offset), header = 8;
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > data.length) return false;
      const extended = data.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) return false;
      size = Number(extended); header = 16;
    } else if (size === 0) size = data.length - offset;
    if (size < header || offset + size > data.length) return false;
    if (offset === 0) {
      if (type !== 'ftyp' || size < header + 8) return false;
      for (let i = offset + header; i + 4 <= offset + size; i += 4)
        if (i !== offset + header + 4 && ['avif', 'avis'].includes(data.toString('ascii', i, i + 4))) brand = true;
    }
    if (type === 'meta') metadata = true;
    if (type === 'mdat' && size > header) pixels = true;
    offset += size;
  }
  return offset === data.length && brand && metadata && pixels;
}

function icoComplete(data: Buffer): boolean {
  if (data.length < 6 || data.readUInt32LE(0) !== 0x00010000) return false;
  const count = data.readUInt16LE(4), directoryEnd = 6 + 16 * count;
  if (!count || directoryEnd > data.length) return false;
  for (let offset = 6; offset < directoryEnd; offset += 16) {
    const length = data.readUInt32LE(offset + 8), start = data.readUInt32LE(offset + 12);
    if (!length || start < directoryEnd || start + length > data.length) return false;
  }
  return true;
}

const complete: Record<string, (data: Buffer) => boolean> = {
  png: pngComplete, apng: pngComplete, jpeg: data => data.subarray(0, 3).equals(Buffer.from([255, 216, 255])) && jpegComplete(data),
  gif: gifComplete, avif: avifComplete, ico: icoComplete,
  webp: data => data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) + 8 === data.length,
  bmp: data => data.length >= 26 && data.toString('ascii', 0, 2) === 'BM' &&
    data.readUInt32LE(2) === data.length && data.readUInt32LE(10) < data.length,
};

export function validImageContent(format: string, absolute: string): boolean {
  return complete[format]?.(readFileSync(absolute)) === true && platform.canDecodeImage(absolute);
}
