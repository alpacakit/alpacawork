/** Common workspace options and the two command trees a host needs. */
import {
  codecs,
  defineEntry,
  defineEntryEndpoint,
  defineEntryNode,
  defineEntryTree,
  defineParameter,
  optional,
} from '@alpacakit/channels';
import { bindCliOptions } from './parameters.js';
import { parseInput } from '@alpacawork/core';
import { workspaceInput } from '@alpacawork/contract/inputs';
import type { EntryTreeNode } from '@alpacakit/channels';

// The root Entry owns common CLI options; its handler creates invocation context.
// The public option maps to the existing context.root contract shared by CLI
// handlers and the HTTP receiver.
function defineWorkspace(rootDescription: string) {
  const workspaceEntry = defineEntry({
    name: 'workspace',
    parameters: [
      defineParameter({
        name: 'workspace',
        description: rootDescription,
        codec: codecs.string(),
        requirement: optional(),
      }),
    ],
    project: ({ values }) => values,
  });
  return defineEntryEndpoint(workspaceEntry, {
    handler: (input: ReturnType<typeof workspaceEntry.project>) =>
      ({ root: parseInput(workspaceInput, input).workspace }),
    channels: [bindCliOptions(workspaceEntry.parameters)],
  });
}

/**
 * Both commands need the same shape: one tree with the children, and a second
 * tree holding only the common options. The root name and the wording of
 * workspace wording differs per command.
 */
export function defineCliRoot<const Children extends readonly EntryTreeNode[]>(
  name: string,
  description: string,
  rootDescription: string,
  children: Children,
) {
  const rootDefinition = {
    name,
    description,
    endpoints: [defineWorkspace(rootDescription)],
  } as const;
  return {
    workspaceTree: defineEntryTree(defineEntryNode(rootDefinition)),
    tree: defineEntryTree(defineEntryNode({ ...rootDefinition, children })),
  };
}
