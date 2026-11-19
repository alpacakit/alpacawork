/** An explicit test release, observed without depending on elapsed wall time. */
import { existsSync } from 'node:fs';

export function waitForGate(path) {
  return new Promise((resolve, reject) => {
    // A file's existence is the gate; polling needs no shared OS watcher resource.
    const poll = setInterval(check, 20);
    // A killed test process cannot run cleanup; its detached bridge still needs a bound.
    const deadline = setTimeout(() => {
      finish(new Error(`Fake gate was not released within 10 seconds: ${path}`));
    }, 10_000);
    function finish(error) {
      clearInterval(poll);
      clearTimeout(deadline);
      if (error) reject(error); else resolve();
    }
    function check() {
      if (!existsSync(path)) return;
      finish();
    }
    check();
  });
}
