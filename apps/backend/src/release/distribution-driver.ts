import { backendEntry } from '../app-paths.js';
/** The target commit owns distribution rules. This driver only transports a bounded command/result. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { packageEnvironment } from './package-facts.js';
import { parseTargets } from './package-closure.js';
import type { DistributionCommand, DistributionImage } from './distribution.js';
export function distributionCommand(owner: string, command: DistributionCommand): DistributionImage {
  command = { ...command, expected: { ...command.expected, targets: parseTargets(command.expected.targets.join(',')) } };
  const entry = backendEntry('release/distribution', owner);
  const result = spawnSync(process.execPath, [entry, JSON.stringify(command)], {
    cwd: owner, env: packageEnvironment(), encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Target distribution ${command.operation} failed (${owner}): ${result.error?.message ?? result.stderr}`, { cause: result.error });
  const image = JSON.parse(result.stdout) as DistributionImage;
  const root = command.operation === 'validate' ? command.source : command.destination;
  if (image.root !== root || image.facts.source !== command.expected.source || image.facts.edition !== command.expected.edition ||
      JSON.stringify(parseTargets(image.facts.targets.join(','))) !== JSON.stringify(command.expected.targets)) throw new Error('Invalid target distribution response');
  return image;
}
