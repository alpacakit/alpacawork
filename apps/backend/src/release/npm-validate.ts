/** Internal validation subprocess, invoked only after confirmation and SRI verification. */
import { readFileSync } from 'node:fs';
import { validatePackage } from './package-facts.js';
try {
  validatePackage(process.argv[2]!, JSON.parse(readFileSync(process.argv[3]!, 'utf8')));
  process.stdout.write('validated\n');
} catch { process.exitCode = 1; }
