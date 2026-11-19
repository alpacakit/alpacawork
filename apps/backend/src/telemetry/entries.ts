/** Local, human-owned telemetry choices; reporting policy belongs to TelemetryService. */
import { defineEntry, defineEntryEndpoint, defineEntryNode } from '@alpacakit/channels';
import { bindCliOptions, withCliHelp } from '@alpacawork/cli-kit';
import { localCaller } from '@alpacawork/contract/access-boundaries';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { Context } from '../entries.js';
import { TelemetryService } from './service.js';

function serviceFor(context: Context): TelemetryService {
  if (!context.cli || localCaller.claimsRun(context.cli.env))
    throw new Problem(PROBLEM_CODE.forbidden, 'Telemetry commands require a person on this PC', undefined,
      { reason: { kind: 'authorization_required', action: 'telemetry', grants: [['human']] } });
  return new TelemetryService(context.root, context.cli.env);
}

const descriptions = {
  status: 'Read this PC’s telemetry consent and reporting status as JSON',
  show: 'Read the allowed telemetry values and local reports as JSON',
  off: 'Stop telemetry from this PC and discard unsent reports',
} as const;

export const telemetryNode = defineEntryNode({ name: 'telemetry', description: 'This PC’s usage reporting consent and records',
  children: (['status', 'show', 'off'] as const).map(name => {
    const entry = defineEntry({ name, parameters: [], project: () => ({}) });
    return defineEntryNode({ name, description: descriptions[name], endpoints: [withCliHelp(defineEntryEndpoint(entry, {
      channels: [bindCliOptions(entry.parameters)],
      handler: async (_input: unknown, context: Context) => {
        const service = serviceFor(context);
        if (name === 'status') return service.status();
        if (name === 'show') return service.show();
        return service.choose(name, 'cli');
      },
    }), () => ['Access: a person on this PC only. --server is unavailable.', localCaller.help])] });
  }),
});
