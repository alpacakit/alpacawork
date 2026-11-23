/** Fixture commands are new one-shot intents unless their body/header already names one. No payload is rewritten. */
import { randomUUID } from 'node:crypto';
import { commandCatalog } from '@alpacawork/contract/commands';
const mutations = new Set(commandCatalog.commands.filter(command => command.kind === 'write' && !command.file).map(command => command.path));
export const commandHeaders = (input: unknown, headers?: HeadersInit): Headers => {
  const result = new Headers(headers);
  const opId = input && typeof input === 'object' && 'opId' in input ? input.opId : undefined;
  if (!result.has('x-alpacawork-op-id')) result.set('x-alpacawork-op-id', typeof opId === 'string' ? opId : randomUUID());
  return result;
};
export const commandFetchWith = (transport: typeof fetch): typeof fetch => (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (init?.method === 'POST' && mutations.has(new URL(url).pathname)) {
    let data: unknown;
    try { data = typeof init.body === 'string' ? JSON.parse(init.body) : undefined; } catch { /* Invalid-body tests remain invalid. */ }
    return transport(input, { ...init, headers: commandHeaders(data, init.headers) });
  }
  return transport(input, init);
};

export const commandFetch = commandFetchWith(globalThis.fetch);
