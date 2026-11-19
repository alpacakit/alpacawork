/** The queue's one ordered control table, shared by both queue surfaces and local/server rows. */
export function rowControl(input: { closing: boolean; withdrawal?: 'live' | 'unknown'; deliveryError?: boolean; sending: boolean; requested: boolean; server: boolean; running: boolean }) {
  if (input.closing) return 'closing';
  if (input.withdrawal === 'live') return 'withdrawing';
  if (input.sending) return 'handing';
  if (input.withdrawal === 'unknown') return 'cancel';
  if (input.deliveryError) return 'cancel';
  if (input.requested) return 'requested';
  return input.server && input.running ? 'send-now' : 'cancel';
}


/** A worded action on a message's delivery line (take back, send again, retry): quiet as the line's words, underlined as the
 * conversation's other worded actions (its "Fold"), brought up to the ink under the pointer. Only how it looks; its box is its words. */
export const LINE_ACTION = "ml-3 text-muted underline decoration-line underline-offset-3 hover:text-ink hover:decoration-ink disabled:no-underline disabled:opacity-38";
