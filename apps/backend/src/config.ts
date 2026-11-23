/** This PC's settings: one YAML document; each consumer validates only the section it owns. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, LineCounter } from 'yaml';
import { z } from 'zod';
import { Problem, PROBLEM_CODE, redactSecrets, faultReason } from '@alpacawork/core';
import { CONFIG_FILE } from '@alpacawork/raw';
import { projectIdSchema } from '@alpacawork/contract/fields';

/**
 * `projects.<P>.cwd`: where this PC keeps a project-type Task's code; its Runs start there by default. '' is set on
 * purpose and turns the inherited location off; a project without a key inherits its parent project's.
 */
export const projectLocationsSchema = z.record(projectIdSchema,
  z.object({ cwd: z.string().refine(value => value === '' || value.startsWith('/'), 'cwd must be empty or an absolute path') }).strict());
const sections = z.object({
  agents: z.unknown().optional(),
  aiStack: z.unknown().optional(),
  coordinatorAiStack: z.unknown().optional(),
  limits: z.unknown().optional(),
  projects: projectLocationsSchema.optional(),
  voice: z.unknown().optional(),
  jev: z.unknown().optional(),
}).strict();

export function parseConfig(text: string) {
  try {
    const lineCounter = new LineCounter();
    const document = parseDocument(text, { uniqueKeys: true, lineCounter });
    if (document.errors.length || document.warnings.length)
      throw new Problem(PROBLEM_CODE.invalidSettings, redactSecrets([...document.errors, ...document.warnings].map(error => error.message).join('; ')), undefined,
        { reason: { kind: 'config_invalid', path: CONFIG_FILE, issues: [...document.errors, ...document.warnings].map(error => ({
          code: error.code, line: error.linePos?.[0]?.line, column: error.linePos?.[0]?.col, diagnostic: redactSecrets(error.message) })) } });
    const values = sections.parse(document.toJS({ maxAliasCount: 0 }));
    return { document, values };
  } catch (cause) {
    if (cause instanceof Problem) throw cause;
    throw new Problem(PROBLEM_CODE.invalidSettings,
      redactSecrets(`Cannot parse ${CONFIG_FILE}: ${cause instanceof Error ? cause.message : String(cause)}`), undefined, { cause, reason: faultReason(cause) });
  }
}

/** The sections of config.yaml as the file holds them now, for a section read outside the file journal; null without a file. */
export function readConfigValues(root: string) {
  let text: string;
  try { text = readFileSync(join(root, CONFIG_FILE), 'utf8'); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause; }
  return parseConfig(text).values;
}

/** config.yaml's bytes through a writer, for the readers that cannot go on without the file. */
export function requireConfigBytes(writer: { read(path: string): Buffer | null }): Buffer {
  const bytes = writer.read(CONFIG_FILE);
  if (bytes === null) throw new Problem(PROBLEM_CODE.invalidSettings, `${CONFIG_FILE} is missing`, undefined,
    { reason: { kind: 'file_missing', path: CONFIG_FILE } });
  return bytes;
}
