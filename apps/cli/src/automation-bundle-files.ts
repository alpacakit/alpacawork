import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Problem, PROBLEM_CODE, parseInput } from '@alpacawork/core';
import {
  AUTOMATION_BUNDLE_LIMITS, automationBundleSchema, isAutomationBundlePath, type AutomationBundle,
} from '@alpacawork/contract/automation-program';
const declaration = 'alpacawork.d.ts';

async function distributedFiles() {
  const { automationExamples, automationTypeDeclaration } = await import('@alpacawork/contract/automation-program-assets');
  return {
    types: { path: declaration, source: automationTypeDeclaration },
    examples: automationExamples.flatMap(example => example.files.map(file => ({
      path: 'examples/' + example.name + '/' + file.path, source: file.source,
    }))),
  };
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function invalid(message: string): never {
  throw new Problem(PROBLEM_CODE.invalidInput, message);
}

async function stat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

/** Resolve the selected root once. Links within it never become bundle paths. */
async function bundleRoot(directory: string, create = false): Promise<string> {
  if (!directory.trim()) invalid('--dir needs a directory');
  const root = resolve(directory);
  if (create && !await stat(root)) await mkdir(root, { recursive: true });
  if (!(await stat(root))?.isDirectory()) invalid('--dir must be a regular directory');
  return realpath(root);
}

async function readSource(file: string, path: string): Promise<{ source: string; bytes: number }> {
  const opened = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await opened.stat()).isFile()) invalid('Expected a regular automation file: ' + path);
    const buffer = Buffer.alloc(AUTOMATION_BUNDLE_LIMITS.fileBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await opened.read(buffer, bytes, buffer.length - bytes, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > AUTOMATION_BUNDLE_LIMITS.fileBytes)
      throw new Problem(PROBLEM_CODE.tooLarge, 'Automation file exceeds 64 KiB: ' + path);
    try {
      return { source: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes)), bytes };
    } catch { return invalid('Automation file must be UTF-8: ' + path); }
  } finally { await opened.close(); }
}

/** Turn --dir into the same bounded bundle that HTTP callers send. */
export async function readAutomationBundle(directory: string): Promise<AutomationBundle> {
  const root = await bundleRoot(directory);
  const { examples } = await distributedFiles();
  const generatedSources = new Map(examples.map(file => [file.path, file.source]));
  const files: AutomationBundle = [];
  let totalBytes = 0;
  const walk = async (relative: string): Promise<void> => {
    const folder = join(root, relative);
    if (!((await stat(folder))?.isDirectory()) || await realpath(folder) !== folder)
      invalid('Automation subdirectories must not be links: ' + relative);
    const entries = await readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1)) {
      const path = relative ? relative + '/' + entry.name : entry.name;
      if (path === declaration) continue;
      const absolute = join(root, path);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile() || !isAutomationBundlePath(path)) invalid('Unsupported automation file: ' + path);
      const { source, bytes } = await readSource(absolute, path);
      if (generatedSources.get(path) === source) continue;
      if (files.length === AUTOMATION_BUNDLE_LIMITS.files)
        throw new Problem(PROBLEM_CODE.tooLarge, 'An automation bundle can contain at most 20 files');
      totalBytes += bytes;
      if (totalBytes > AUTOMATION_BUNDLE_LIMITS.totalBytes)
        throw new Problem(PROBLEM_CODE.tooLarge, 'An automation bundle cannot exceed 256 KiB');
      files.push({ path, source });
    }
  };
  await walk('');
  if (!files.some(({ path }) => path === AUTOMATION_BUNDLE_LIMITS.entry)) invalid('Add main.ts to the automation directory');
  return parseInput(automationBundleSchema, files);
}

type OutputFile = Readonly<{ path: string; source: string }>;
type ExportReceipt = { directory: string; files: readonly string[] };

async function writeFiles(directory: string, files: readonly OutputFile[]): Promise<ExportReceipt> {
  const root = await bundleRoot(directory, true);
  const paths = files.map(file => file.path);
  const occupied = new Set(paths);
  if (occupied.size !== files.length) invalid('Automation files must have different paths');
  const folders = new Set<string>();
  for (const path of paths) {
    const segments = path.split('/');
    for (let count = 1; count < segments.length; count++) {
      const parent = segments.slice(0, count).join('/');
      if (occupied.has(parent)) invalid('An automation path is both a file and directory: ' + parent);
      folders.add(parent);
    }
  }
  // Check before writing so an occupied path cannot leave a partially unpacked bundle.
  for (const folder of folders) {
    const target = await stat(join(root, folder));
    if (target && !target.isDirectory()) invalid('An automation directory is occupied: ' + folder);
  }
  for (const path of paths) {
    if (await stat(join(root, path))) throw new Problem(PROBLEM_CODE.conflict, 'An automation file already exists: ' + path);
  }
  const createdFiles: { path: string; dev: number; ino: number }[] = [];
  const createdFolders: string[] = [];
  try {
    for (const folder of folders) {
      const absolute = join(root, folder);
      if (!(await stat(absolute))) { await mkdir(absolute); createdFolders.push(absolute); }
      if ((await realpath(absolute)) !== absolute) invalid('An automation directory must not be a link: ' + folder);
    }
    for (const file of files) {
      const absolute = join(root, file.path);
      if (await realpath(dirname(absolute)) !== dirname(absolute)) invalid('An automation directory must not be a link: ' + file.path);
      const opened = await open(absolute, 'wx', 0o600);
      try {
        const { dev, ino } = await opened.stat();
        createdFiles.push({ path: absolute, dev, ino });
        await opened.writeFile(file.source, 'utf8');
      } finally { await opened.close(); }
    }
  } catch (error) {
    for (const created of createdFiles.reverse()) {
      const current = await stat(created.path).catch(() => null);
      if (current && current.dev === created.dev && current.ino === created.ino) await unlink(created.path).catch(() => {});
    }
    for (const folder of createdFolders.reverse()) await rmdir(folder).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Problem(PROBLEM_CODE.conflict, 'An automation path became occupied while writing', undefined, { cause: error });
    throw error;
  }
  return { directory: root, files: paths };
}

/** Unpack one server version together with the local SDK declaration. */
export async function writeAutomationBundle(directory: string, files: readonly OutputFile[],
  sdkDeclaration?: string): Promise<ExportReceipt> {
  const bundle = parseInput(automationBundleSchema, files);
  let totalBytes = 0;
  for (const file of bundle) {
    if (!isAutomationBundlePath(file.path)) invalid('Unsupported automation path: ' + file.path);
    const bytes = Buffer.from(file.source, 'utf8');
    if (bytes.toString('utf8') !== file.source) invalid('Automation file must be UTF-8: ' + file.path);
    if (bytes.length > AUTOMATION_BUNDLE_LIMITS.fileBytes)
      throw new Problem(PROBLEM_CODE.tooLarge, 'Automation file exceeds 64 KiB: ' + file.path);
    totalBytes += bytes.length;
    if (totalBytes > AUTOMATION_BUNDLE_LIMITS.totalBytes)
      throw new Problem(PROBLEM_CODE.tooLarge, 'An automation bundle cannot exceed 256 KiB');
  }
  const types = sdkDeclaration === undefined ? (await distributedFiles()).types : { path: declaration, source: sdkDeclaration };
  return writeFiles(directory, [types, ...bundle]);
}

/** Write the SDK declaration and the example bundles from this installed client. */
export async function writeAutomationTypes(directory: string): Promise<ExportReceipt> {
  const { types, examples } = await distributedFiles();
  return writeFiles(directory, [types, ...examples]);
}
