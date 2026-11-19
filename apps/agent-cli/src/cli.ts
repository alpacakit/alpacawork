#!/usr/bin/env node
/** A single CLI entry point. Add an agent by registering its runtime here. */
import { AGENT_ADAPTERS, type BridgeAdapterId } from '@alpacawork/contract/agent-adapters';
import { run, type Runtime, type RuntimeIO } from './run.js';
import { CodexRuntime } from './codex.js';
import { resolveExecutable } from '@alpacawork/core';
import { CopilotRuntime, inspectCopilotArgs } from './copilot.js';
import { GrokRuntime } from './grok.js';
import { PiRuntime } from './pi.js';
import { AgyRuntime } from './agy.js';

type AgentModule = { create(args: string[], io: RuntimeIO, command: string): Runtime; inspect?(args: string[]): Promise<boolean> };
const agents: Record<BridgeAdapterId, AgentModule> = {
  codex: { create: (args, io, command) => new CodexRuntime(args, io, command) },
  copilot: { create: (args, io) => new CopilotRuntime(args, io), inspect: inspectCopilotArgs },
  grok: { create: (args, io, command) => new GrokRuntime(args, io, command) },
  agy: { create: (args, io, command) => new AgyRuntime(args, io, command) },
  pi: { create: (args, io, command) => new PiRuntime(args, io, command) },
};

const [agent, ...args] = process.argv.slice(2);
const module = agent && Object.hasOwn(agents, agent) ? agents[agent as BridgeAdapterId] : undefined;
if (!module) {
  process.stderr.write(`alpacawork-agent: ${agent ? `unknown agent: ${agent}` : 'agent name is required'}\nUsage: alpacawork-agent <agent> [agent options]\n`);
  process.exitCode = 1;
} else {
  try {
    const definition = AGENT_ADAPTERS[agent as BridgeAdapterId];
    if (!await module.inspect?.(args)) {
      let explicit: string | undefined;
      if (args[0] === '--command') {
        explicit = args[1];
        if (!explicit || !definition.command) throw new Error('--command requires an external executable path');
        args.splice(0, 2);
      }
      const command = definition.command ? resolveExecutable(definition.command, explicit, process.env.PATH ?? '') : '';
      run(io => module.create(args, io, command));
    }
  }
  catch (error) {
    process.stderr.write(`alpacawork-agent: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
