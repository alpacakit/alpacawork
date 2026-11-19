import { z } from 'zod';

/**
 * The screen's one read of app updates: what the gear's mark, the settings' update button and its one status line
 * draw. The release Owner decides which candidate is offered, fixed, retryable or withdrawn; the screen never
 * derives that from candidates itself, it only draws this projection and sends the person's intent through the existing
 * update review/confirm/cancel entries.
 */
const version = z.string().min(1).max(256);
const candidateId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
/** Running Runs the switch waits for; zero switches at once. */
const runs = z.number().int().nonnegative();
export const updateRunConflictSchema = z.object({ reason: z.enum(['format', 'database']), runs: runs.min(1) }).strict();
export type UpdateRunConflict = z.infer<typeof updateRunConflictSchema>;
export const updateStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  /** A candidate a person may start. `note` says why it is offered again: the last start was put off or its version withdrawn. */
  z.object({ kind: z.literal('available'), candidateId, version, runs,
    /** It changes the execution FORMAT or the database, so it switches only once no Run is unfinished (`runs` is 0). */
    requiresNoRuns: z.boolean(),
    /** What the version changes, when its release says so; null when no release notes are known (not "no changes"). */
    changes: z.array(z.string().min(1)).nullable(),
    note: z.discriminatedUnion('kind', [z.object({ kind: z.literal('deferred') }).strict(),
      z.object({ kind: z.literal('withdrawn'), version }).strict()]).nullable() }).strict(),
  z.object({ kind: z.literal('fetching'), opId: z.uuid(), version }).strict(),
  /** Fetched and waiting for running Runs to end before switching; the person may put it off (cancel the operation). */
  z.object({ kind: z.literal('waiting'), opId: z.uuid(), version, runs: runs.min(1) }).strict(),
  /** The fixed candidate is still valid, so the same one may be tried again; a newer latest does not replace it. */
  z.object({ kind: z.literal('failed'), candidateId, version,
    /** What kind of fault stopped it, for the next step the person can take: the network, this PC's disk, or anything else. */
    category: z.enum(['network', 'disk', 'other']), runConflict: updateRunConflictSchema.optional() }).strict(),
  /** The fixed candidate became unusable and there is no other: nothing to press. */
  z.object({ kind: z.literal('withdrawn'), version }).strict(),
  z.object({ kind: z.literal('applying'), opId: z.uuid(), version }).strict(),
  z.object({ kind: z.literal('recovering'), opId: z.uuid(), version }).strict(),
  z.object({ kind: z.literal('attention'), opId: z.uuid().nullable(), version: version.nullable() }).strict(),
  /** The server runs the new version; this page still shows the old one until it is loaded again. */
  z.object({ kind: z.literal('done'), version }).strict(),
]);
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

/** One confirmation binds the fixed candidate and overwrite conditions; resume reuses the exact three values. */
const reviewDigest = z.string().regex(/^[a-f0-9]{64}$/);
/** The skills this update overwrites on this machine, by name: the ones its installation record lists, bound by the digest. */
const skills = z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(64);
export const updateReviewSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), candidateId, version, reviewDigest, skills,
    resume: z.object({ opId: z.uuid(), candidateId, reviewDigest }).strict().nullable() }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
]);
export type UpdateReview = z.infer<typeof updateReviewSchema>;
/** A confirmed or cancelled operation as the update entries answer it. */
export const updateOperationSchema = z.looseObject({ opId: z.string().min(1), terminal: z.string().nullable() });
