/**
 * What whoever receives a failure does next; part of the wire (`error.retry`).
 * - fix: refused as sent; nothing was written. Change it or give up.
 * - reread: refused because something changed elsewhere; nothing was written. Read the latest, then decide.
 * - later: not accepted right now; nothing was written. The same thing may be sent again shortly.
 * - check: not refused, but not confirmed either; it may have been written. Read again to check
 *   (the same operation ID may be resent).
 */
export const RETRY = { fix: 'fix', reread: 'reread', later: 'later', check: 'check' } as const;
export type Retry = (typeof RETRY)[keyof typeof RETRY];

/** Machine-readable reason a server/CLI failure carries; values are part of the wire and must not change. */
export const PROBLEM_CODE = {
  voiceTooLarge: 'voice_too_large',
  voiceEmpty: 'voice_empty',
  voiceRecognitionFailed: 'voice_recognition_failed',
  urgentToUser: 'urgent_to_user',
  questionExpired: 'question_expired',
  questionClosed: 'question_closed',
  questionStopped: 'question_stopped',
  attachmentRequestReplaced: 'attachment_request_replaced',

  alreadyInitialized: 'already_initialized',
  sandboxedCaller: 'sandboxed_caller',
  tooManyChildren: 'too_many_children',
  notResumable: 'not_resumable',
  responsibleMissing: 'responsible_missing',
  conversationBusy: 'conversation_busy',
  handoffPending: 'handoff_pending',
  handoverRequired: 'handover_required',
  automaticLimit: 'automatic_limit',
  busy: 'busy',
  publicationPending: 'publication_pending',
  publicationNeedsReview: 'publication_needs_review',
  conflict: 'conflict',
  databaseUnavailable: 'database_unavailable',
  finishedBranch: 'finished_branch',
  forbidden: 'forbidden',
  idExhausted: 'id_exhausted',
  idempotencyConflict: 'idempotency_conflict',
  invalidDocument: 'invalid_document',
  invalidInput: 'invalid_input',
  invalidOption: 'invalid_option',
  invalidPath: 'invalid_path',
  invalidRoot: 'invalid_root',
  invalidSettings: 'invalid_settings',
  invalidYaml: 'invalid_yaml',
  ioFailure: 'io_failure',
  missingDocument: 'missing_document',
  notFound: 'not_found',
  runsUnavailable: 'runs_unavailable',
  parentUnavailable: 'parent_unavailable',
  readFailed: 'read_failed',
  saveUnconfirmed: 'save_unconfirmed',
  restoreChanged: 'restore_changed',
  tooDeep: 'too_deep',
  tooLarge: 'too_large',
  unavailable: 'unavailable',
  unsafeEndpoint: 'unsafe_endpoint',
  unsafePath: 'unsafe_path',
  unstable: 'unstable',
  unknownCommand: 'unknown_command',
  unsupportedPlatform: 'unsupported_platform',
} as const;
export type ProblemCode = (typeof PROBLEM_CODE)[keyof typeof PROBLEM_CODE];

const rule = (status: number, retry: Retry) => ({ status, retry }) as const;
/**
 * The only place a code's HTTP status and next step are decided; a thrown Problem names its code
 * and every reader (HTTP status, `error.retry`, the CLI exit code) reads this.
 * A code whose meaning differs by situation is split into two codes, not two rows.
 */
export const PROBLEM_RULE: { readonly [code in ProblemCode]: { readonly status: number; readonly retry: Retry } } = {
  voice_too_large: rule(413, RETRY.fix),
  voice_empty: rule(400, RETRY.fix),
  voice_recognition_failed: rule(503, RETRY.check),
  urgent_to_user: rule(400, RETRY.fix),
  question_expired: rule(409, RETRY.reread),
  question_closed: rule(409, RETRY.reread),
  question_stopped: rule(409, RETRY.reread),
  attachment_request_replaced: rule(400, RETRY.fix),
  invalid_input: rule(400, RETRY.fix),
  invalid_option: rule(400, RETRY.fix),
  unknown_command: rule(400, RETRY.fix),
  invalid_settings: rule(400, RETRY.fix),
  invalid_yaml: rule(400, RETRY.fix),
  invalid_document: rule(400, RETRY.fix),
  invalid_path: rule(400, RETRY.fix),
  unsafe_path: rule(400, RETRY.fix),
  unsafe_endpoint: rule(400, RETRY.fix),
  too_deep: rule(400, RETRY.fix),
  too_many_children: rule(400, RETRY.fix),
  id_exhausted: rule(400, RETRY.fix),
  sandboxed_caller: rule(400, RETRY.fix),
  forbidden: rule(403, RETRY.fix),
  not_found: rule(404, RETRY.fix),
  missing_document: rule(404, RETRY.fix),
  too_large: rule(413, RETRY.fix),
  conflict: rule(409, RETRY.reread),
  idempotency_conflict: rule(409, RETRY.reread),
  invalid_root: rule(409, RETRY.reread),
  already_initialized: rule(409, RETRY.reread),
  not_resumable: rule(409, RETRY.fix),
  /** A finished Task with unfinished Tasks below it, either way round (the finished-branch rule). */
  finished_branch: rule(409, RETRY.fix),
  busy: rule(409, RETRY.later),
  handoff_pending: rule(409, RETRY.later),
  /** This responsible cannot be released alone: replace them with `agent handover` or `agent assign --replace`. */
  handover_required: rule(409, RETRY.fix),
  /** Another conversation holds the Task's claim for its turn; the claim ends with that turn or its expiry. */
  automatic_limit: rule(409, RETRY.fix),
  conversation_busy: rule(409, RETRY.later),
  responsible_missing: rule(409, RETRY.later),
  parent_unavailable: rule(409, RETRY.later),
  runs_unavailable: rule(503, RETRY.later),
  database_unavailable: rule(503, RETRY.later),
  unstable: rule(503, RETRY.later),
  unsupported_platform: rule(503, RETRY.later),
  save_unconfirmed: rule(503, RETRY.check),
  restore_changed: rule(409, RETRY.fix),
  publication_pending: rule(503, RETRY.check),
  publication_needs_review: rule(503, RETRY.check),
  read_failed: rule(503, RETRY.check),
  io_failure: rule(503, RETRY.check),
  /** Also every failure that is not a Problem: a fault here, so whether a write landed is not known. */
  unavailable: rule(503, RETRY.check),
};
