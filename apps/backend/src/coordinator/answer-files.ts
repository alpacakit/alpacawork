/** The answer publication boundary: explicit local links become conversation-owned snapshots. */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync, constants } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Problem, PROBLEM_CODE, hasCode } from '@alpacawork/core';
import { markdownLinks, type AnswerFile } from '@alpacawork/contract';
import { requirePublished, FileJournal } from '../control/file-journal.js';
import { attachmentFileName } from '../control/task-files.js';
import { mediaContentProblem } from '../control/report-media.js';
import { attachmentLimit } from '../agents-settings.js';
import { coordinatorFilePath } from './files.js';

function localPath(href: string): string | null {
  if (href.startsWith('/api/')) return null; // An app-relative delivery URL is not an OS path.
  if (href.startsWith('file://')) { try { return fileURLToPath(href); } catch { return null; } }
  return href.startsWith('/') ? href : href.startsWith('~/') ? join(homedir(), href.slice(2)) : null;
}
/** Read the explicit local file within its attachment size limit. */
function readSource(path: string, limit: number): Buffer {
  const parts = path.slice(1).split('/');
  if (!parts.every(part => part && part !== '.' && part !== '..' && !part.includes('\\') && !part.includes('\0')))
    throw new Problem(PROBLEM_CODE.unsafePath, 'Invalid answer file path', undefined, { reason: { kind: 'invalid_answer_file_path' } });
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Problem(PROBLEM_CODE.unsafePath, 'Expected a regular answer file', undefined,
      { reason: { kind: 'expected_regular_answer_file_without_links' } });
    if (stat.size > limit) throw new Problem(PROBLEM_CODE.tooLarge, 'Answer file exceeds attachment limit', undefined, { reason: { kind: 'answer_file_exceeds_attachment_limit' } });
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) throw new Problem(PROBLEM_CODE.invalidInput, 'Answer file changed while reading', undefined, { reason: { kind: 'answer_file_changed_while_reading' } });
      offset += read;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw new Problem(PROBLEM_CODE.invalidInput, 'Answer file changed while reading', undefined, { reason: { kind: 'answer_file_changed_while_reading' } });
    return bytes;
  } finally { closeSync(fd); }
}

export function captureAnswerFiles(root: string, conversation: string, id: string, answer: string): AnswerFile[] {
  const files: AnswerFile[] = [], journal = new FileJournal(root), limit = attachmentLimit(root);
  for (const href of new Set(markdownLinks(answer).map(link => link.href))) {
    const source = localPath(href);
    // Task files keep their Task ownership. Metadata/configuration under the data root is never copied.
    if (!source || resolve(source) === resolve(root) || resolve(source).startsWith(`${resolve(root)}/`)) continue;
    if (files.length >= 20) { files.push({ state: 'unavailable', href, reason: 'limit' }); continue; }
    const key = createHash('sha256').update(href).digest('hex');
    const name = attachmentFileName(`${key.slice(0, 16)}-${basename(source)}`);
    const opId = `coordinator-answer:${id}:${key}`;
    const prior = journal.operationGet(opId);
    if (prior.state === 'committed') { files.push(prior.body as AnswerFile); continue; }
    let bytes: Buffer;
    try { bytes = readSource(source, limit); }
    catch (error) {
      const reason = hasCode(error, 'ENOENT') ? 'missing' : error instanceof Problem && error.code === PROBLEM_CODE.tooLarge ? 'too_large'
        : error instanceof Problem && error.code === PROBLEM_CODE.invalidInput ? 'invalid' : hasCode(error, 'ELOOP') || hasCode(error, 'ENOTDIR') || hasCode(error, 'EACCES') || error instanceof Problem && error.code === PROBLEM_CODE.unsafePath ? 'unsafe' : null;
      if (!reason) throw error;
      files.push({ state: 'unavailable', href, reason }); continue;
    }
    // Validate the exact copied bytes, not a source that another process can replace during publication.
    const temporary = mkdtempSync(join(tmpdir(), 'alpacawork-answer-'));
    let invalid: boolean;
    try {
      const path = join(temporary, name); writeFileSync(path, bytes, { mode: 0o600 });
      invalid = mediaContentProblem(name, path) !== null;
    } finally { rmSync(temporary, { recursive: true, force: true }); }
    if (invalid) { files.push({ state: 'unavailable', href, reason: 'invalid' }); continue; }
    const file: AnswerFile = { state: 'ready', href, name, size: bytes.length };
    const outcome = journal.putManagedFile({ path: coordinatorFilePath(conversation, id, name, 'answers'), opId, bytes,
      expectedDigest: null, result: file, fingerprintKey: ['answer', id, href] });
    requirePublished(outcome);
    files.push(file);
  }
  return files;
}
