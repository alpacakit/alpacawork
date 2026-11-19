import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../e2e/server.ts';

test('Run texts come from DB detail reads', async () => {
  const runtime = await start();
  try {
    const expected = '10 synthetic vendors matched. The remaining two require checking the originals.';
    const get = async (path: string) => {
      const response = await fetch(runtime.origin + path);
      assert.equal(response.status, 200);
      return response;
    };
    assert.ok(!(await (await get('/api/workspace/live')).text()).includes(expected));
    assert.ok(!(await (await get('/api/task/view?task=T111')).text()).includes(expected));
    const reply = await (await get('/api/run/get?run=R1')).json();
    assert.deepEqual(reply.files, [{ kind: 'result', source: 'alpacawork.sqlite', state: 'present', bytes: Buffer.byteLength(expected), text: expected }]);
    const prompt = await (await get('/api/run/get?run=R1&kind=prompt')).json();
    assert.equal(prompt.files[0].source, 'alpacawork.sqlite');
    assert.equal(prompt.files[0].state, 'present');
    assert.equal(prompt.files[0].text, 'Reconcile invoices from 12 synthetic vendors and check for differences and duplicates.');
  } finally { await runtime.stop(); }
});
