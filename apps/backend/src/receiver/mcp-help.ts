import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accessHelp } from '@alpacawork/contract/access-help';
import { commandCatalog, commandFlag, commandRuleHelp, type Command } from '@alpacawork/contract/commands';
import { mcpFlagGuide, mcpGuideName } from '@alpacawork/contract/mcp';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { z } from 'zod';
import { appRoot } from '../app-paths.js';

const commands = new Map(commandCatalog.commands.map(command => [command.words.join(' '), command]));

function details(command: Command) {
  const names = new Map(command.options.map(option => [commandFlag(option), option.key]));
  const keys = (text: string) => text.replace(/--[a-z-]+/g, flag => names.get(flag) ?? flag);
  const inputs: { key: string; description: string; required: boolean; schema?: object }[] = command.options.filter(option => !option.local && !(command.file?.attachmentRoot &&
    (option.key === 'requestId' || option.key === 'name'))).map(option => {
    const field = command.schema.shape[option.key]!;
    const { $schema: _dialect, ...schema } = z.toJSONSchema(field, { io: 'input', unrepresentable: 'any' });
    return { key: option.key, description: keys(option.description.replace(/ \(a UTF-8 file's absolute path, or - for stdin\)$/, '')),
      required: !field.isOptional(), schema };
  });
  if (command.file?.attachmentRoot) inputs.push({ key: 'path', required: true, schema: { type: 'string' }, description: 'attachments/<requestId>/<name> in the Task folder' });
  if (command.file?.body === 'bytes') inputs.push({ key: 'content / contentBase64 / file', required: true,
    description: 'Exactly one: UTF-8 text or base64 up to 8 MiB, or an absolute path on a Run stdio relay' });
  if (command.file?.response === 'bytes') inputs.push({ key: 'offset, length, version, encoding, digest', required: false,
    description: 'Byte range; reuse version for the next chunk. encoding is text or base64. digest: true hashes the whole file.' });
  const notes = command.help?.trim().split('\n')
    .filter(line => !/stdin|\bCLI\b|cwd rule|automatically attaches/.test(line)).map(keys) ?? [];
  if (command.kind === 'run') notes.push('If the answer is lost, the result is unknown. Send only when you intend to run the command.');
  return { inputs, rules: commandRuleHelp(command), access: keys(accessHelp(command.access).trim().replace(/^Access(?: \([^)]+\))?:\s*/, '')), notes };
}

export function mcpCommandHelp(selected?: string[]) {
  const entries = selected?.length ? selected.map(name => {
    const command = commands.get(name);
    if (!command) {
      const message = 'Unknown command: ' + name;
      throw new Problem(PROBLEM_CODE.invalidInput, message, undefined, {
        reason: { kind: 'validation_error' }, issues: [{ path: 'commands', code: 'invalid_value', message }],
      });
    }
    return [name, command] as const;
  }) : [...commands];
  return { guide: mcpFlagGuide, commands: entries.map(([command, spec]) => ({
    command, kind: spec.kind, description: spec.description, ...(selected?.length ? details(spec) : {}),
  })) };
}

export async function mcpSkill(name: z.infer<typeof mcpGuideName>) {
  return { name, text: await readFile(join(appRoot(import.meta.url), 'skills', 'alpacawork', name), 'utf8') };
}
