/** Human-only HTTP authorization. Accepted work proceeds outside the receiver lifetime. */
import { codecs, defineEntry, defineEntryEndpoint, defineEntryNode, defineParameter, optional, required } from '@alpacakit/channels';
import { bindHttpEntry } from '@alpacakit/channels/http';
import { z } from 'zod';
import { updateReviewSchema } from '@alpacawork/contract';
import { parseInput } from '@alpacawork/core';
import { requireRoot, withAct, type Context } from '../entries.js';
import { reviewUpdate, confirmAndStartUpdate, cancelUpdate } from '../release/update-operation.js';
import { idSchema } from '../release/npm-records.js';
import { updateStatus } from '../release/update-status.js';
const inputs = {
  status: z.object({}).strict(),
  review: z.object({ candidateId: idSchema.optional() }).strict(),
  confirm: z.object({ opId: z.uuid(), candidateId: idSchema, reviewDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  cancel: z.object({ opId: z.uuid() }).strict(),
};
const parameter = (name: string, optionalValue = false) => defineParameter({ name, description: name,
  codec: codecs.string(), requirement: optionalValue ? optional() : required() });
/** Each entry's act is its own name, except the status read: the screen's side of reviewing an update (update.review). */
function entry<Name extends keyof typeof inputs>(name: Name, parameters: ReturnType<typeof parameter>[],
  method: 'GET' | 'POST', work: (workspace: string, input: z.output<typeof inputs[Name]>) => unknown,
  act: `update.${'review' | 'confirm' | 'cancel'}` = `update.${name as Exclude<Name, 'status'>}`) {
  return defineEntryNode({ name, description: name, endpoints: [withAct(defineEntryEndpoint(defineEntry({ name, parameters,
    project: ({ values }) => values }), {
    handler: (raw: unknown, context: Context) => work(requireRoot(context), parseInput(inputs[name], raw) as z.output<typeof inputs[Name]>),
    channels: [bindHttpEntry({ method })],
  }), { name: act })] });
}
export const updateNode = defineEntryNode({ name: 'update', description: 'Read the update status; review, confirm, or cancel a fixed update', children: [
  entry('status', [], 'GET', workspace => updateStatus(workspace), 'update.review'),
  entry('review', [parameter('candidateId', true)], 'GET', async (workspace, input) => updateReviewSchema.parse(await reviewUpdate(workspace, input.candidateId))),
  entry('confirm', [parameter('opId'), parameter('candidateId'), parameter('reviewDigest')], 'POST', confirmAndStartUpdate),
  entry('cancel', [parameter('opId')], 'POST', (workspace, input) => cancelUpdate(workspace, input.opId)),
] });
