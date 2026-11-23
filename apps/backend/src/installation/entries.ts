/** Public setup uses the same installation, skill writer and switch as managed updates; uninstall is its way out. */
import { codecs, defineEntry, defineEntryEndpoint, defineEntryNode, defineParameter, optional } from '@alpacakit/channels';
import { bindCliOptions, withCliHelp, withCliOutput } from '@alpacawork/cli-kit';
import { existsSync } from 'node:fs';
import { uiLocaleFromEnvironment } from '@alpacawork/core/ui-language';
import { serverText } from '@alpacawork/i18n/server';
import { canonicalLanguageTag } from '@alpacawork/contract';
import { z } from 'zod';
import { parseInput, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { setupLog, setupResult, openSetupBrowser, readSetupAgentReadiness } from './setup-output.js';
import type { Context } from '../entries.js';
import { runSetup } from './public-setup.js';
import { runUninstall } from './uninstall.js';

const entry = defineEntry({ name: 'setup', parameters: [defineParameter({ name: 'releases',
  description: 'Releases directory (default: recorded path or ~/.local/share/alpacawork/releases)',
  codec: codecs.string(), requirement: optional() }),
  defineParameter({ name: 'port', description: 'Loopback port, 1..65535 (default: the recorded port; an available port when new). Another free port replaces the recorded one after confirmation, while no agent is running', codec: codecs.string(), requirement: optional() }),
  defineParameter({ name: 'public-host', description: 'Public host[:port] behind a reverse proxy (default: the recorded host). Another value replaces the recorded one after confirmation', codec: codecs.string(), requirement: optional() }),
  defineParameter({ name: 'mcp', description: 'Enable (on) or disable (off) MCP for the private tailnet', codec: codecs.string(), requirement: optional() }),
  defineParameter({ name: 'confirm-private-tailnet', description: 'Confirm private access when setup cannot read Tailscale settings', codec: codecs.boolean(), requirement: optional() }),
  defineParameter({ name: 'lang', description: 'Initial screen and AI reply language for a new workspace (BCP 47, for example ja-JP)', codec: codecs.string(), requirement: optional() }),
  defineParameter({ name: 'yes', description: 'Skip confirmation and apply setup', codec: codecs.boolean(), requirement: optional() }),
  defineParameter({ name: 'no-open', description: 'Do not open a browser after setup', codec: codecs.boolean(), requirement: optional() }),
], project: ({ values }) => values });
export const setupNode = defineEntryNode({ name: 'setup',
  description: 'Confirm installation, install managed skills and start the local server. On an installed PC, run it again to approve a changed port, public host, MCP setting or Node.js path; the service then also takes this terminal PATH',
  endpoints: [withCliOutput(defineEntryEndpoint(entry, { channels: [bindCliOptions(entry.parameters, { yes: ['-y', '--yes'] })], handler: async (values: { releases?: string; port?: string; 'public-host'?: string; mcp?: string; 'confirm-private-tailnet'?: boolean; lang?: string; yes?: boolean; 'no-open'?: boolean }, context: Context) => {
    if (!context.cli) throw new Error('Setup requires a local CLI');
    const language = values.lang === undefined ? undefined : canonicalLanguageTag(values.lang);
    if (language === null) throw new Problem(PROBLEM_CODE.invalidInput, '--lang must be a BCP 47 language tag');
    const mcp = parseInput(z.object({ mcp: z.enum(['on', 'off']).optional() }), { mcp: values.mcp }).mcp;
    const env = { ...context.cli.env, ...(language ? { LC_ALL: language } : {}) };
    const locale = uiLocaleFromEnvironment(env);
    let readiness: ReturnType<typeof readSetupAgentReadiness> | undefined;
    const log = setupLog(env);
    const terminal = { input: process.stdin, output: process.stdout, env,
      discardPendingInput: () => { while (process.stdin.read() !== null) { /* One terminal reader. */ } } };
    let result: Awaited<ReturnType<typeof runSetup>>;
    try { result = await runSetup({ ...context.cli, env, language, onFailure: line => { log(line); process.stderr.write(line + '\n'); },
      onReady: url => { readiness = readSetupAgentReadiness(url); }, explicit: context.root,
      yes: values.yes === true, releases: values.releases, port: values.port === undefined ? undefined : Number(values.port), publicHost: values['public-host'],
      mcp: mcp === undefined ? undefined : mcp === 'on', confirmPrivateTailnet: values['confirm-private-tailnet'] === true }, log, terminal);
    } catch (error) {
      if (existsSync(log.path)) process.stderr.write(serverText(locale)('server:setup.log', { path: log.path }) + '\n');
      throw error;
    }
    const browserOpened = result.installed && !!result.url && await openSetupBrowser(result.url, env, { noOpen: values['no-open'] !== undefined });
    const summary = setupResult(result, (await readiness) ?? [], locale, browserOpened);
    if (summary) process.stdout.write(summary + '\n');
    return result;
  } }), () => null)] });

const uninstall = defineEntry({ name: 'uninstall', parameters: [
  defineParameter({ name: 'yes', description: 'Skip confirmation and uninstall', codec: codecs.boolean(), requirement: optional() }),
], project: ({ values }) => values });
export const uninstallNode = defineEntryNode({ name: 'uninstall',
  description: 'Remove alpacawork from this PC and keep the data folder',
  endpoints: [withCliHelp(defineEntryEndpoint(uninstall, { channels: [bindCliOptions(uninstall.parameters, { yes: ['-y', '--yes'] })], handler: (values: { yes?: boolean }, context: Context) => {
    if (!context.cli) throw new Error('Uninstall requires a local CLI');
    return runUninstall({ env: context.cli.env, explicit: context.root, yes: values.yes === true }, line => console.error(`uninstall: ${line}`));
  } }), () => [
    'Run it as yourself: not with sudo, not from an agent that alpacawork started.',
    'It lists what it removes and what stays, and starts on Enter. Any other key cancels and changes nothing.',
    'Without a terminal, or to skip the confirmation, add --yes (or -y): it prints the same list and goes ahead.',
    'Removes: the auto-start registration (stopped first), what alpacawork put in the releases folder,',
    '  alpacawork\'s settings, installation record and state, the managed skills in the skill record (with',
    '  local edits), and the links to them in agents\' own skills folders.',
    'Keeps: the data folder with your tasks and history. Delete it by hand when you no longer need it.',
    '  A folder that is the data folder or contains it is kept whole, with the installation record that',
    '  names it. Anything else you keep in the releases folder stays, and so does that folder.',
    'Refuses, changing nothing: while agents or an update are still running (stop them or wait); when the',
    '  auto-start registration cannot be removed (it prints what to do); when an installation record',
    '  exists that this version cannot read (use the alpacawork version that wrote it).',
    'Safe to run again: a run that stopped part-way removes what is left; with nothing installed it says so.',
    '--workspace is refused.',
    'Afterwards, remove the command itself: npm uninstall -g alpacawork',
  ])] });
