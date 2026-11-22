/** Host-neutral local facts; dispatch the installed release directly. */
import { readPackageVersion } from '../apps/backend/dist/package-version.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const root = new URL('../', import.meta.url);
/** Local commands accept their workspace after the verb; the backend owns it as a root option.
 * Move only that option's original tokens, preserving every value and all other arguments. */
function localArguments(args, commandIndex) {
  const tail = args.slice(commandIndex + 1), moved = new Set(), global = [];
  const { tokens } = parseArgs({ args: tail, options: { workspace: { type: 'string' } }, strict: false, allowPositionals: true, tokens: true });
  for (const token of tokens) if (token.kind === 'option' && token.name === 'workspace') {
    const count = token.inlineValue ? 1 : 2;
    global.push(...tail.slice(token.index, token.index + count));
    for (let i = 0; i < count; i++) moved.add(token.index + i);
  }
  return [...args.slice(0, commandIndex), ...global, args[commandIndex], ...tail.filter((_, index) => !moved.has(index))];
}
export async function launch(mode = 'launcher', args = process.argv.slice(2)) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || major === 24 && minor < 16) {
    throw new Error('alpacawork requires Node >=24.16.0; install Node separately');
  }
  const bundledFacts = readPackageVersion(fileURLToPath(root));
  const target = process.platform === 'darwin' && process.arch === 'arm64' ? 'darwin-arm64'
    : process.platform === 'linux' && process.arch === 'x64' && process.report.getReport().header.glibcVersionRuntime ? 'linux-x64-glibc' : null;
  let selectedRoot = root, localServer;
  if (mode === 'launcher') {
    const { tokens } = parseArgs({ args, options: { workspace: { type: 'string' }, server: { type: 'string' } }, strict: false, allowPositionals: true, tokens: true });
    const command = tokens.find(token => token.kind === 'positional');
    if (command?.value === 'telemetry' && tokens.some(token => token.kind === 'option' && token.name === 'server'))
      throw new Error('--server is unavailable for telemetry; use the command on this PC');
    // Installation management starts here so a broken release cannot block the way in or out.
    if (command && ['setup', 'uninstall', 'telemetry', 'deploy', 'start', 'stop', 'restart', 'status'].includes(command.value)) { mode = 'backend'; args = localArguments(args, command.index); }
    else if (args[0] === 'skills' && args[1] === 'update') { mode = 'skills'; args = args.slice(2); }
    else if (args[0] === 'backend') [mode, ...args] = args;
    else {
      mode = 'cli';
    }
    if (mode === 'backend' && command?.value === 'deploy' || mode === 'cli' || mode === 'skills' && !args.some(arg => arg === '--package-version' || arg.startsWith('--package-version='))) {
      // Local package facts stay readable without loading a host-specific installation runtime.
      if (target && bundledFacts.targets?.includes(target)) {
        const local = (await import(new URL('apps/backend/dist/installation/local-cli.js', root).href)).localCli(process.env, command?.value === 'deploy' ? 'deploy' : 'client');
        selectedRoot = pathToFileURL(local.release + '/'); localServer = local.server;
      }
    }
  }
  const facts = selectedRoot.href === root.href ? bundledFacts : readPackageVersion(fileURLToPath(selectedRoot));
  if (mode !== 'skills' && args.length === 1 && args[0] === '--version') { console.log(facts.version); return; }
  if (mode !== 'skills' && args.length === 1 && args[0] === 'version') { console.log(JSON.stringify(facts)); return; }
  if (!target || !facts.targets?.includes(target)) throw new Error(`This package has no runtime closure for ${process.platform}/${process.arch}`);
  if (mode === 'skills') await (await import(new URL('apps/backend/dist/installation/skills-update.js', selectedRoot).href)).main(args, { release: fileURLToPath(selectedRoot) });
  else if (mode === 'cli') process.exitCode = await (await import(new URL('apps/cli/dist/cli.js', selectedRoot).href)).main(args, { server: localServer });
  else if (mode === 'backend') await (await import(new URL('apps/backend/dist/backend.js', selectedRoot).href)).main(args);
  else if (mode === 'agent') {
    process.argv = [process.execPath, fileURLToPath(new URL('apps/agent-cli/dist/cli.js', root)), ...args];
    await import(new URL('apps/agent-cli/dist/cli.js', root).href);
  } else throw new Error('Unknown packaged entry');
}
