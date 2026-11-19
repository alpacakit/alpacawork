/** Align two CLI return passes after each has selected the same open answer. */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';

const dir = process.env.ALPACAWORK_TEST_PASS_BARRIER;
if (dir) {
  const request = RequestService.prototype.request;
  RequestService.prototype.request = async function(input, context) {
    if (context.origin === 'returns') {
      writeFileSync(join(dir, `ready-${process.pid}`), input.requestId);
      const deadline = Date.now() + 10_000;
      while (readdirSync(dir).filter(name => name.startsWith('ready-')).length < 2) {
        if (Date.now() > deadline) throw new Error('Two return passes did not reach admission');
        await delay(10);
      }
    }
    try { return await request.call(this, input, context); }
    catch (error) {
      if (context.origin === 'returns') writeFileSync(join(dir, `rejected-${process.pid}`), error.code ?? String(error));
      throw error;
    }
  };
}
