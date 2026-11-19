import type { Document } from "../src/features/coordinator/editor/document";
import { answeredQuestions } from "../src/features/coordinator/editor/document";
import { captureReaderSubmission, type SentIntent } from "../src/features/coordinator/reader-send";
import type { ReaderCard } from "../src/features/reader/next-question";
import type { Task } from "../src/data/types";

type Scope = Parameters<typeof captureReaderSubmission>[4];

/** A draft's submission as the coordinator input captures it (`CoordinatorInput`), in the words the draft holds. */
export const captureReaderSend = (doc: Document, tasks: readonly Task[], requestId: string, scope: Scope, retry?: () => void) =>
  captureReaderSubmission(answeredQuestions(doc), doc, tasks, requestId, scope, retry);

/** An intent's submission as the input captures it at its press, with nothing written. */
export const captureReaderIntent = (intent: SentIntent, card: ReaderCard | null, tasks: readonly Task[], requestId: string, scope: Scope, retry: () => void) =>
  captureReaderSubmission({ intent }, { type: "doc", content: [] }, tasks, requestId, scope, retry, card);
