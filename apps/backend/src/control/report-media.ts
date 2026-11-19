/** Reject invalid or broken media references before any report-like log is committed. */
import { openSync, readSync, closeSync, realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { reportEmbed, reportMediaReferences } from '@alpacawork/contract/report-media';
import { fileKind, reportEmbeds, type ReportFileKind } from '@alpacawork/contract/markdown-embeds';
import { fileFormat } from '@alpacawork/contract/file-formats';
import { Problem, PROBLEM_CODE, type ProblemReason } from '@alpacawork/core';
import { attachmentLimit } from '../agents-settings.js';
import { validImageContent } from './image-content.js';

function invalid(message: string, reason?: ProblemReason): never {
  throw new Problem(PROBLEM_CODE.invalidInput, message, undefined, { reason: reason, issues: [{ path: 'description', code: 'invalid_media', message }] });
}

type ContentProblem = { message: string; reason?: ProblemReason };
type EmbedCheck = {
  content: (name: string, absolute: string) => ContentProblem | null;
  tooLarge?: (name: string, limit: number) => ContentProblem;
};

/** Contract classifies a source; this exhaustive table alone owns its server checks. */
const embedChecks: { [K in ReportFileKind]: EmbedCheck } = {
  image: {
    content: imageContentProblem,
    tooLarge: (path, limit) => ({ message: `Report image exceeds ${limit / 1024 / 1024} MiB, the attachment limit: ${path}`,
      reason: { kind: 'report_image_exceeds_mib_attachment_limit', limit: String(limit / 1024 / 1024), path } }),
  },
  video: { content: videoContentProblem },
  audio: { content: audioContentProblem },
  diff: {
    content: diffContentProblem,
    tooLarge: (path, limit) => ({ message: `Report diff exceeds the ${limit / 1024 / 1024} MiB attachment limit: ${path}` }),
  },
};

export function validateReportMedia(root: string, taskPath: string, description?: string): void {
  if (!description) return;
  const limit = attachmentLimit(root);
  for (const reference of reportMediaReferences(description)) {
    if (!reference.alt.trim()) return invalid('Report media need a purpose in ![purpose](path)', { kind: 'report_media_need_purpose_purpose_path' });
    const embed = reportEmbed(reference.path);
    if (!embed) return invalid(`Invalid report media path: ${reference.path}`, { kind: 'invalid_report_media_path', referencePath: String(reference.path) });
    const { path, kind } = embed;
    const check = embedChecks[kind];
    let folder: string;
    try { folder = realpathSync(join(root, taskPath)); }
    catch { return invalid(`Report media does not exist: ${path}`, { kind: 'report_media_does_not_exist', path: String(path) }); }
    let absolute = folder;
    const segments = path.split('/');
    for (const [index, segment] of segments.entries()) {
      absolute = join(absolute, segment);
      let stat: ReturnType<typeof lstatSync>;
      try { stat = lstatSync(absolute); }
      catch { return invalid(`Report media does not exist: ${path}`, { kind: 'report_media_does_not_exist', path: String(path) }); }
      if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile()))
        return invalid(`Report media must be a regular Task file without links: ${path}`, { kind: 'report_media_must_regular_task_file_without_links', path: String(path) });
      if (index === segments.length - 1 && check.tooLarge && stat.size > limit) {
        const problem = check.tooLarge(path, limit);
        return invalid(problem.message, problem.reason);
      }
    }
    const problem = check.content(path, absolute);
    if (problem) return invalid(problem.message, problem.reason);
  }
}

/** Content checks for every managed Markdown media source. */
export function mediaContentProblem(name: string, absolute: string): ContentProblem | null {
  const kind = fileKind(name);
  return kind && reportEmbeds(kind) ? embedChecks[kind].content(name, absolute) : null;
}

function diffContentProblem(name: string, absolute: string): ContentProblem | null {
  const fd = openSync(absolute, 'r'), bytes = Buffer.alloc(64 * 1024), decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const length = readSync(fd, bytes, 0, bytes.length, null);
      if (!length) break;
      decoder.decode(bytes.subarray(0, length), { stream: true });
    }
    decoder.decode();
    return null;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { message: `Report diff must be UTF-8: ${name}` };
  } finally { closeSync(fd); }
}

function prefix(absolute: string): { bytes: Buffer; length: number } {
  const bytes = Buffer.alloc(12), fd = openSync(absolute, 'r');
  let length: number;
  try { length = readSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
  return { bytes, length };
}

function imageContentProblem(name: string, absolute: string): ContentProblem | null {
  return validImageContent(fileFormat(name)!.id, absolute) ? null
    : { message: `Report image cannot be opened: ${name}`, reason: { kind: 'report_image_cannot_opened', name } };
}

function videoContentProblem(name: string, absolute: string): ContentProblem | null {
  const { bytes, length } = prefix(absolute);
  const format = fileFormat(name)!.id;
  const valid = format === 'webm'
    ? length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    : format === 'ogv' ? length >= 4 && bytes.toString('ascii', 0, 4) === 'OggS'
      : length >= 12 && (bytes.toString('ascii', 4, 8) === 'ftyp' ||
        format === 'mov' && ['moov', 'mdat', 'wide'].includes(bytes.toString('ascii', 4, 8)));
  return valid ? null : { message: `Report media does not match its file format: ${name}`, reason: { kind: 'report_media_format_mismatch', name } };
}

function audioContentProblem(name: string, absolute: string): ContentProblem | null {
  const { bytes, length } = prefix(absolute), format = fileFormat(name)!.id;
  const valid = length >= 4 && (format === 'm4a' ? length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp'
    : format === 'wav' ? length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE'
      : format === 'flac' ? bytes.toString('ascii', 0, 4) === 'fLaC'
        : format === 'ogg' ? bytes.toString('ascii', 0, 4) === 'OggS'
          : format === 'mp3' ? bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0
            : format === 'aac' && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0);
  return valid ? null : { message: `Report media does not match its file format: ${name}`, reason: { kind: 'report_media_format_mismatch', name } };
}
