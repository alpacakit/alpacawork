/** The body passes; the real cleanup Owner must retain faults and capture before disposal. */
import { test as base } from '../fixtures.ts';
import { start } from '../server.ts';
import { withRuntimeEvidence } from '../failure-evidence.ts';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
const test = base.extend({
  runtime: async ({}, use, info) => {
    const runtime = await start();
    const fault = process.env.CAPTURE_CLEANUP_FAULT;
    const attach = info.attach.bind(info);
    info.attach = async (name, options) => {
      if (fault === 'pending-capture' && name === 'runtime-control') {
        const path = info.outputPath('runtime-raw/.alpacawork/alpacawork.sqlite');
        const stat = statSync(path);
        writeFileSync(info.outputPath('capture-held.json'), JSON.stringify({
          raw: JSON.parse(readFileSync(info.outputPath('runtime-raw/capture-manifest.json'), 'utf8')),
          inode: stat.ino, mtime: stat.mtimeMs, bytes: readFileSync(path).toString('base64'), pid: process.pid,
        }));
        await new Promise(() => {});
      }
      return attach(name, options);
    };
    await withRuntimeEvidence(runtime, info, () => use(runtime), [
      { name: 'injected-stop', run: async () => {
        // Preparation and the passed body keep the normal budget. Only these
        // deliberately hung teardowns need a shorter deadline to exercise exit capture.
        if (fault === 'timeout' || fault === 'pending-capture') info.setTimeout(10_000);
        if (fault === 'timeout') await new Promise(() => {});
        if (fault === 'capture-fault') mkdirSync(info.outputPath('runtime-control.sqlite'));
        if (fault !== 'success') throw Error('deliberate stop fault after passed body');
      } },
      { name: 'actual-stop', run: runtime.stop },
    ]);
  },
});
test('passed body then cleanup', async ({ runtime }, info) => {
  writeFileSync(info.outputPath('before.json'), JSON.stringify({ ...runtime, pid: process.pid }));
});
