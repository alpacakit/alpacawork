/** Inject a fault only after the real CLI admission/stop transaction has committed. */
import { RunStore } from '@alpacawork/runs';
import { Problem } from '@alpacawork/core';
import { main } from '../apps/backend/test-dist/backend.js';
const write = RunStore.prototype.write;
let writes = 0;
RunStore.prototype.write = function (callback) {
  if (++writes === 2) throw new Problem('busy', 'Injected post-save settle busy');
  return write.call(this, callback);
};
await main();
