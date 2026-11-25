/** The adopted question shape shared by the browser projection and isolated CLI delivery checks, as Task values. */
import type { TaskValues } from '@alpacawork/contract';

export const descriptiveQuestion: TaskValues = {
  decide: [{
    decide_kind: 'choose', decide_question: 'Include the illustrated cover in the fictional plant catalog?',
    decide_choices: [
      { decide_choice: 'Include Illustrated cover',
        decide_choice_detail: 'The cover shows an imaginary plant and an editable caption. Include it after the sample review. The printed colors are unverified.',
        decide_choice_recommended: 'The sample cover and caption are ready to review.' },
      { decide_choice: 'Defer Plain cover',
        decide_choice_detail: 'Keep the fictional catalog cover plain and defer the illustration.' },
    ],
  }],
  notes: 'The printed colors are unverified.',
};
/** A question that offers stopping the Task: its one choice, and what stopping means (`decide_stop`). */
export const completionQuestion: TaskValues = {
  decide: [{
    decide_kind: 'choose', decide_question: 'Accept the investigation results and complete this Task?',
    decide_choices: [
      { decide_choice: 'Accept Finalize results',
        decide_choice_detail: 'Accept the results that satisfy the investigation criteria and complete this Task.',
        decide_choice_recommended: 'The investigation criteria are satisfied.' },
    ],
    decide_stop: 'Reject the investigation results and stop this Task.',
  }],
  notes: 'Acceptance of the investigation itself, rather than a request to implement it.',
};
