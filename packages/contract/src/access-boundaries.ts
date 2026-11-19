/** Entry-specific restrictions shared by execution and command help. No database facts are loaded here. */
type Input = Readonly<Record<string, unknown>>;
type Caller = { kind: string; taskId?: string };
const ownReport = (input: Input, caller: Caller) => caller.kind === 'run' &&
  (input.task === undefined || input.task === caller.taskId);

export const reportCallerRules = {
  checkpoint: {
    allows: (input: Input, caller: Caller): boolean =>
      (input.values === undefined && input.nextConversation === undefined) ||
      (input.aboutRun === undefined && ownReport(input, caller)),
    help: '--values-file / --next-conversation: only a Run owner report; unavailable with --about-run.',
  },
  askTo: {
    allows: (input: Input, caller: Caller): boolean =>
      input.askTo === undefined || (input.state === 'waiting' && ownReport(input, caller)),
    help: '--ask-to: only a Run asking on its own Task (--state waiting) may choose the question recipient.',
  },
};

export const urgentRecipient = {
  allows: (requester: string | null): requester is string => requester !== null,
  help: '--urgent: the requester must be a Task; when the requester is the user, ask a question instead.',
};

export const replyAccess = {
  allows: (speaker: { source: string; runId?: string }, referencesReply: (runId: string) => boolean): boolean =>
    speaker.source === 'screen' && !!speaker.runId && referencesReply(speaker.runId),
  help: 'Only a screen coordinator Run may read a reply referenced by a message actually delivered to that Run.',
};

/** Task-less receipts use screen access; every distinct referenced Task otherwise requires task.read. */
export function operationReadActions(tasks: readonly string[]): {
  action: { name: 'screen' } | { name: 'task.read' }; task: string | null;
}[] {
  return tasks.length
    ? [...new Set(tasks)].map(task => ({ action: { name: 'task.read' as const }, task }))
    : [{ action: { name: 'screen' }, task: null }];
}
export const operationReadHelp =
  'A receipt naming Tasks requires task.read on every referenced Task (Runs stay within their project); ' +
  'a receipt naming no Task requires screen access.';

/** Local admin/release do not carry the HTTP coordinator identity. Presence claims a Run, even with an empty value. */
export const localCaller = {
  claimsRun: (env: Readonly<Record<string, string | undefined>>): boolean =>
    'ALPACAWORK_RUN' in env || 'ALPACAWORK_RUN_TOKEN' in env,
  help: 'Local credentials: without ALPACAWORK_RUN / ALPACAWORK_RUN_TOKEN keys, the caller is treated as a person ' +
    '(including an outside coordinator); either key, even empty, claims a Run. HTTP coordinator identity does not carry over.',
};
