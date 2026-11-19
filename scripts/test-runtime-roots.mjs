import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { RUNTIME_EXTERNAL_ROOTS } from './runtime-roots.mjs';

// Check installed entrances, without loading native code or generated products.
for (const { name, from } of RUNTIME_EXTERNAL_ROOTS) {
  try {
    createRequire(resolve(from, 'package.json')).resolve(name);
  } catch (cause) {
    console.error(`Test dependency entrance missing: ${name} from ${from}: ${cause.message}`);
    process.exitCode = 1;
  }
}
