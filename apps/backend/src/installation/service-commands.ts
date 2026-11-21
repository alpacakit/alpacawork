import { defineEntry, defineEntryEndpoint, defineEntryNode } from '@alpacakit/channels';
import { bindCliOptions, CLI_EXIT_CODE, defaultPolicy, withCliOutput, type CliPolicy } from '@alpacawork/cli-kit';
import { localCaller } from '@alpacawork/contract/access-boundaries';
import { platform } from '@alpacawork/core';
import { uiLocaleFromEnvironment } from '@alpacawork/core/ui-language';
import { serverText } from '@alpacawork/i18n/server';
import type { Context } from '../entries.js';
import { holdReleases } from '../release/layout.js';
import { serviceDefinition } from './setup.js';
import { InstallationStore, installationPath, type Installation } from './store.js';

const descriptions = {
  start: 'Start this server if it is stopped',
  stop: 'Stop this server',
  restart: 'Restart this server, or start it if it is stopped',
  status: 'Show whether this server is running and its URL',
} as const;
type ServiceAction = keyof typeof descriptions;
type ServiceResult = { ok: boolean; message: string };

export function runServiceCommand(action: ServiceAction, env: NodeJS.ProcessEnv, service = platform.service,
  workspace?: string): ServiceResult {
  const t = serverText(uiLocaleFromEnvironment(env));
  const success = (message: string): ServiceResult => ({ ok: true, message });
  const refused = (message: string): ServiceResult => ({ ok: false, message });
  if (env.ALPACAWORK_RUN_CLI || localCaller.claimsRun(env)) return refused(t('server:serviceCommands.localOnly'));
  if (workspace !== undefined) return refused(t('server:serviceCommands.workspace'));
  const store = new InstallationStore(installationPath(env));
  const record = store.read();
  if (!record?.service || !record.releases) return refused(t('server:serviceCommands.setup'));

  function operate(record: Installation): ServiceResult {
    const { service: settings } = record;
    if (!settings || !record.releases) return refused(t('server:serviceCommands.setup'));
    const definition = serviceDefinition(record, store.path);
    const observed = service.observe(definition);
    if (observed.state === 'unavailable') return refused(t('server:serviceCommands.unavailable'));
    if (observed.state === 'conflict') return refused(t('server:serviceCommands.conflict'));
    if (action === 'status') return success(observed.running
      ? t('server:serviceCommands.running', { url: `http://127.0.0.1:${settings.port}` })
      : t('server:serviceCommands.stopped'));
    if (observed.state === 'absent') return action === 'stop'
      ? success(t('server:serviceCommands.stopped')) : refused(t('server:serviceCommands.repair'));
    if (action === 'start' && observed.running) return success(t('server:serviceCommands.alreadyRunning'));
    if (!service[action](definition)) return refused(t('server:serviceCommands.failed'));
    switch (action) {
      case 'start': return success(t('server:serviceCommands.starting'));
      case 'stop': return success(t('server:serviceCommands.stopped'));
      case 'restart': return success(t('server:serviceCommands.restarting'));
    }
  }

  if (action === 'status') return operate(record);
  // Setup, deploy and uninstall use this same lock while changing the service.
  const unlock = holdReleases(record.releases);
  try {
    const current = store.read();
    if (current?.releases !== record.releases) return refused(t('server:serviceCommands.setup'));
    return operate(current);
  } finally { unlock(); }
}

const policy: CliPolicy = {
  ...defaultPolicy,
  exitCode: value => (value as ServiceResult).ok ? CLI_EXIT_CODE.success : CLI_EXIT_CODE.failure,
};
const commands = (Object.keys(descriptions) as ServiceAction[]).map(name => {
  const entry = defineEntry({ name, parameters: [], project: () => ({}) });
  const endpoint = withCliOutput(defineEntryEndpoint(entry, {
    channels: [bindCliOptions(entry.parameters)],
    handler: (_input: unknown, context: Context) =>
      runServiceCommand(name, context.cli!.env, platform.service, context.root),
  }), value => (value as ServiceResult).message);
  return { node: defineEntryNode({ name, description: descriptions[name], endpoints: [endpoint] }), endpoint };
});
export const serviceCommandNodes = commands.map(({ node }) => node);
export const serviceCommandPolicies = commands.map(({ endpoint }) => [endpoint.handler, policy] as const);
