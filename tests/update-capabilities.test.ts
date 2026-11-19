/** Every persisted handoff record uses the same target compatibility rule. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateCapabilities, assertUpdateHandoff, UpdateCompatibilityError } from '../apps/backend/test-dist/release/update-capabilities.js';
test('handoff checks each record, accepts declared migrations and preserves unknown target records', t => {
  const root = mkdtempSync(join(tmpdir(), 'update-capabilities-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const place = {releases:root, workspace:join(root, 'workspace')};
  const put = (update:unknown) => writeFileSync(join(root, 'package.json'), JSON.stringify({alpacawork:{update}}));
  const current = updateCapabilities();
  for (const saved of [false, true]) {
    if (saved) writeFileSync(join(root, 'switch.json'), JSON.stringify({version:4, skillsWriteStarted:false, opId:'synthetic', workspace:place.workspace,
      old:null, target:'/synthetic-target', previous:null, phase:'committed', schema:null}));
    put(current); assert.doesNotThrow(() => assertUpdateHandoff(root, place));
    for (const name of Object.keys(current.records)) {
      const missing:any = structuredClone(current); delete missing.records[name]; put(missing);
      assert.throws(() => assertUpdateHandoff(root, place), new RegExp(name));
      const future:any = structuredClone(current), from = future.records[name].write;
      future.records[name] = {read:[from,999], write:999, migrate:[]}; put(future);
      assert.throws(() => assertUpdateHandoff(root, place), UpdateCompatibilityError);
      future.records[name].migrate = [{from,to:999}]; put(future);
      assert.doesNotThrow(() => assertUpdateHandoff(root, place));
      future.records[name].read = [999]; put(future);
      assert.throws(() => assertUpdateHandoff(root, place), UpdateCompatibilityError);
    }
  }
  const extra:any = structuredClone(current); extra.records.service = {read:[3],write:3,migrate:[]}; put(extra);
  assert.doesNotThrow(() => assertUpdateHandoff(root, place));
  put({...current,handoff:999}); assert.throws(() => assertUpdateHandoff(root, place), /handoff/);
  put({}); assert.throws(() => assertUpdateHandoff(root, place), UpdateCompatibilityError);
  writeFileSync(join(root, 'switch.json'), JSON.stringify({version:3})); put(current);
  assert.throws(() => assertUpdateHandoff(root, place), /Unsupported switch journal/);
});
