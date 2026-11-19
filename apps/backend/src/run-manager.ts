/** Internal observation entry. fd 3 is the manager lock. */
import { runIdSchema } from '@alpacawork/contract/fields';
import { manageRun } from './runs/manager.js';
try {
  const [root, id, attempt] = process.argv.slice(2);
  if (!root || !id || !attempt || process.argv.length !== 5) throw new Error('Expected <root> <R-id> <attempt-id>');
  await manageRun(root, runIdSchema.parse(id), attempt);
} catch (error) {
  console.log(`Run manager failed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
}
