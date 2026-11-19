import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { resolveExecutable } from '@alpacawork/core';

const dist = process.env.ALPACAWORK_AGENT_DIST ?? join(import.meta.dirname, '../../apps/agent-cli/test-dist');
const { run } = await import(pathToFileURL(join(dist, 'run.js')).href);
const { PiRuntime } = await import(pathToFileURL(join(dist, 'pi.js')).href);

// Observe the actual read boundary without starting or consuming stdin.
process.stdin.once('end', () => process.stdout.write(`${JSON.stringify({ type: 'fixture.stdin.closed' })}\n`));

const [agent, ...args] = process.argv.slice(2);
if (agent === 'pi') run(io => new PiRuntime(args, io, resolveExecutable('pi', undefined, process.env.PATH ?? '')));
else throw new Error(`Unknown fixture agent: ${agent}`);
