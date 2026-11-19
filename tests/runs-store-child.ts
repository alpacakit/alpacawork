import { createFixtureRun } from './helpers/run-fixture.ts';
/** Separate-process transaction holder for WAL, contention, and crash tests: its Runs work on the Task `task` names. */
import { RunStore } from '@alpacawork/runs';
import { fields } from './runs-fixtures.ts';
const [root, mode, timeout, task] = process.argv.slice(2);
const store = new RunStore(root, { busyTimeoutMs: Number(timeout ?? 1000) });
process.send!('ready');
process.once('message', () => {
  try {
    if (mode === 'hold') {
      store.write(tx => {
        createFixtureRun(store, tx, fields({ task }), 'held');
        process.send!('holding');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      });
    } else if (mode === 'before') {
      store.write(tx => {
        const run = createFixtureRun(store, tx, fields({ task }), 'before crash');
        process.send!({ created: run.id });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
      });
    } else if (mode === 'after') {
      const run = store.write(tx => createFixtureRun(store, tx, fields({ task }), 'after crash'));
      process.send!({ committed: run.id });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
    } else {
      const run = store.write(tx => createFixtureRun(store, tx, fields({ task }), 'contender'));
      process.send!({ saved: run.id });
    }
  } catch (error) { process.send!({ error: (error as { code: string }).code }); }
  finally { store.close(); process.disconnect(); }
});
