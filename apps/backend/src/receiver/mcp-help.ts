import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { accessHelp } from '@alpacawork/contract/access-help';
import { commandCatalog, commandFlag, commandRuleHelp, type Command } from '@alpacawork/contract/commands';
import { mcpFileReadOptions, mcpFlagGuide, mcpGuideName } from '@alpacawork/contract/mcp';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { z } from 'zod';
import { appRoot } from '../app-paths.js';

const commands = new Map(commandCatalog.commands.map(command => [command.words.join(' '), command]));
const keys = new Map(commandCatalog.commands.flatMap(command => command.options.flatMap(option => {
  const flag = commandFlag(option);
  return option.kind === 'boolean' ? [[flag, option.key], [flag.replace(/^--/, '--no-'), option.key + ': false']] as const
    : [[flag, option.key]] as const;
})));
const inputText = (text: string) => text.replace(/--[a-z][a-z-]*/g, flag => keys.get(flag) ?? flag).replace(/ -h\b/g, '');

function inputHelp(field: z.ZodType, description: string) {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(field, { io: 'input', unrepresentable: 'any' });
  return { ...schema, description: inputText(description) };
}

const rangeDescriptions = {
  offset: 'Start at this byte.',
  length: 'Byte limit for this chunk. Text defaults to 16 KiB; base64 is limited to 24 KiB.',
  version: 'Pass the returned version when reading the next chunk.',
  encoding: 'Use base64 explicitly for binary bytes.',
  digest: 'Hash the complete file.',
} as const satisfies Record<keyof typeof mcpFileReadOptions.shape, string>;

function details(command: Command) {
  const inputs: Record<string, object> = {};
  const required: string[] = [];
  for (const option of command.options) {
    if (option.local || command.file?.attachmentRoot && (option.key === 'requestId' || option.key === 'name')) continue;
    const field = command.schema.shape[option.key]!;
    inputs[option.key] = inputHelp(field, option.description);
    if (!field.isOptional()) required.push(option.key);
  }
  const rules = commandRuleHelp(command);
  if (command.file?.attachmentRoot) {
    inputs.path = { type: 'string', description: 'attachments/<requestId>/<name> in the Task folder' };
    required.push('path');
  }
  if (command.file?.body === 'bytes') {
    inputs.content = { type: 'string', description: 'UTF-8 file contents.' };
    inputs.contentBase64 = { type: 'string', description: 'Standard padded base64.' };
    inputs.file = { type: 'string', description: 'Absolute path on a Run stdio relay.' };
    rules.push('Supply one of content, contentBase64 or file. Inline contents are limited to 8 MiB.');
  }
  if (command.file?.response === 'bytes') {
    for (const key of Object.keys(rangeDescriptions) as (keyof typeof rangeDescriptions)[])
      inputs[key] = inputHelp(mcpFileReadOptions.shape[key], rangeDescriptions[key]);
  }
  const notes = command.help?.trim().split('\n').map(inputText);
  return { ...(Object.keys(inputs).length ? { inputs } : {}), ...(required.length ? { required } : {}),
    ...(rules.length ? { rules } : {}), access: inputText(accessHelp(command.access).trim().replace(/^Access(?: \([^)]+\))?:\s*/, '')),
    ...(notes?.length ? { notes } : {}) };
}

export function mcpCommandHelp(selected?: string[]) {
  const detailed = !!selected?.length;
  const entries = detailed ? selected.map(name => {
    const command = commands.get(name);
    if (!command) {
      const message = 'Unknown command: ' + name;
      throw new Problem(PROBLEM_CODE.invalidInput, message, undefined, {
        reason: { kind: 'validation_error' }, issues: [{ path: 'commands', code: 'invalid_value', message }],
      });
    }
    return [name, command] as const;
  }) : [...commands];
  return { ...(detailed ? {} : { guide: mcpFlagGuide }), commands: entries.map(([command, spec]) => ({
    command, kind: spec.kind, description: inputText(spec.description), ...(detailed ? details(spec) : {}),
  })) };
}

export async function mcpSkill(name: z.infer<typeof mcpGuideName>) {
  return { name, text: await readFile(join(appRoot(import.meta.url), 'skills', 'alpacawork', name), 'utf8') };
}
