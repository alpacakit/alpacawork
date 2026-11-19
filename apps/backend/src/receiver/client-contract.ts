import type { MiddlewareHandler } from 'hono';
import { fileURLToPath } from 'node:url';
import { packageVersionForEntry } from '@alpacawork/core';
import { clientContractRefusal, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
import { cliRepairCommand } from '../installation/skills-update-command.js';

/** Refuse before admission, caller import or any command/file handler can read or save data. */
export function clientContract(): MiddlewareHandler {
  const version = packageVersionForEntry(fileURLToPath(import.meta.url));
  return async (c, next) => {
    if (c.req.header('x-alpacawork-client') === 'cli') {
      const refusal = clientContractRefusal(c.req.header(CONTRACT_HEADER) ?? null, version, () => cliRepairCommand(version));
      if (refusal) throw refusal;
    }
    await next();
  };
}
