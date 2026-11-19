import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installAgentStub } from '../tests/helpers/agent-stub.ts';

export function holdCoordinator(root: string, argv: readonly string[]) {
  const gate = join(root, '.last-answer-hold');
  writeFileSync(gate, 'hold');
  const module = join(root, 'last-answer-gate.mjs');
  writeFileSync(module, `import {existsSync} from 'node:fs'; import {setTimeout} from 'node:timers/promises'; const end=Date.now()+60000; while(existsSync(${JSON.stringify(gate)}) && Date.now()<end) await setTimeout(20);`);
  // Gate the already installed local fake, preserving its launch arguments and guard preload.
  const [node, ...args] = argv;
  installAgentStub(root, 'claude', [node!, `--import=${pathToFileURL(module).href}`, ...args]);
  return () => { if (existsSync(gate)) rmSync(gate); };
}
