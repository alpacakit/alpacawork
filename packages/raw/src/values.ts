export { selectedValueSchema, selectedValuesSchema } from '@alpacawork/core/selection';

/**
 * Browser-safe: @alpacawork/contract builds its field schemas from these, so it must not import node modules.
 * The only definition of each value rule; input schemas and stored-document validation both read it.
 */
/** Unanchored source for a SHA-256 hex digest: Task hashes, operation fingerprints and Run credentials. */
export const DIGEST_PATTERN = '[0-9a-f]{64}';
/** Unanchored source for a body mark: the FNV-1a hash of a Task body that the reader's unread baseline keeps. */
export const BODY_MARK_PATTERN = '[0-9a-f]{8}';
/** Unanchored source for a Run ID: R1, R2, … in creation order. */
export const RUN_ID_PATTERN = 'R[1-9][0-9]*';
/** A remaining-work estimate is whole minutes, at most one week. */
export const ESTIMATE_MINUTES = { min: 1, max: 7 * 24 * 60 } as const;
/** Characters (code points) in a Task title. */
export const MAX_TITLE_LENGTH = 200;
/** Characters (code points) in a report description. */
export const MAX_DETAIL_LENGTH = 1000;
/** UTF-8 bytes in a Task body. */
export const MAX_CONTROL_BODY = 1024 * 1024;
/** UTF-8 bytes in config.yaml. */
export const MAX_DOCUMENT = 1024 * 1024;
/** UTF-8 bytes in an instruction; the Run prompt holds 256 KiB and start-text context stays within the other 96 KiB. */
export const MAX_INSTRUCTION_BYTES = 160 * 1024;
