import { defaultPolicy, runCli } from '@alpacawork/cli-kit';
import { policyFor, tree, workspaceTree } from './cli/entries.js';
import { applyEnvironmentFile, environmentFileProblems } from './environment-file.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runCli(args, {
    tree,
    workspaceTree,
    defaultPolicy,
    policyFor,
    runtime: (publish) => ({
      cli: { env: process.env, cwd: process.cwd() },
      // Load the HTTP receiver only for `serve`.
      serve: async (root: string, port: number, options: { publicHost?: string; timing?: boolean }) => {
        // Before anything of the server reads its environment. Only this process reads the file: a test or a tool
        // that starts the receiver itself keeps the environment it was given.
        const environmentFile = applyEnvironmentFile(process.env);
        for (const line of environmentFileProblems(environmentFile)) console.error(line);
        const { serveUntilSignal } = await import('./receiver/lifetime.js');
        await serveUntilSignal(root, port, publish, { ...options, environmentFile });
      },
    }) as never,
  });
}
