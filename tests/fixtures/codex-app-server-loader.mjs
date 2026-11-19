/** Test-only dependency resolution: the real CLI/parser/protocol, an explicit repo app-server dependency. */
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assertGuardLoaded } from '../../e2e/guard.ts';
const subject = process.env.ALPACAWORK_AGENT_DIST ? pathToFileURL(process.env.ALPACAWORK_AGENT_DIST + '/codex.js').href : new URL('../../apps/agent-cli/test-dist/codex.js', import.meta.url).href;
const fixture = new URL('./codex-app-server-spawn.mjs', import.meta.url).href;
assertGuardLoaded('bridge-fixture-loader');
let resolved = false;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:child_process' && context.parentURL === subject) {
    resolved = true; return { url: fixture, shortCircuit: true };
  }
  return next(specifier, context);
} });

// Importing this declarations-only module proves the seam before CLI execution. A moved/bundled subject fails closed.
await import(subject);
if (!resolved) throw new Error('Bridge fixture dependency was not resolved before CLI execution');
assertGuardLoaded('bridge-fixture-ready');
