/**
 * Imports the step times of a workspace's past Runs from the agents' conversation records (import-step-times.ts):
 *
 *   node <release>/apps/backend/dist/runs/import-step-times-entry.js <workspace> [--dry-run]
 *
 * Prints one JSON line per Run (its steps, how many got a time, the journal lines added, and why it got none), then a
 * line with the totals. `--dry-run` writes nothing and counts what would be added. Reads the records where this PC's
 * person keeps them (CLAUDE_CONFIG_DIR or ~/.claude; CODEX_HOME, or ~/.codex-alpacawork and ~/.codex). Importing again
 * adds nothing already there, so it can run while the server serves.
 */
import { parseArgs } from 'node:util';
import { importStepTimes, STEP_IMPORT_REASONS, type StepImportReason } from './import-step-times.js';

const { values, positionals } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } }, allowPositionals: true });
if (positionals.length !== 1 || !positionals[0]!.startsWith('/')) {
  process.stderr.write('Usage: import-step-times-entry.js <absolute workspace path> [--dry-run]\n');
  process.exit(2);
}
const write = !values['dry-run'];
const totals = { runs: 0, imported: 0, steps: 0, timed: 0, added: 0,
  reasons: Object.fromEntries(STEP_IMPORT_REASONS.map(reason => [reason, 0])) as Record<StepImportReason, number> };
await importStepTimes(positionals[0]!, { write, onRun: result => {
  process.stdout.write(JSON.stringify(result) + '\n');
  totals.runs++; totals.steps += result.steps; totals.timed += result.timed; totals.added += result.added;
  if (result.reason) totals.reasons[result.reason]++; else if (result.timed) totals.imported++;
} });
process.stdout.write(JSON.stringify({ totals: { ...totals, written: write } }) + '\n');
