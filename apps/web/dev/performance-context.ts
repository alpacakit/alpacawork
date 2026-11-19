import type { Action, Screen } from '../../backend/src/diagnostics/protocol.ts';

// DOM presence only: surfaces may coexist, be covered, or still be animating.
// Never inspect text, labels, URLs, values or identity-bearing attribute values.
export function screenContext(): Screen[] {
  const result: Screen[] = [];
  if (document.querySelector('[data-time-tree], [data-result-list]')) result.push('list');
  if (document.querySelector('[data-reader-mode]')) result.push('detail');
  if (document.querySelector('[data-coordinator-card]:not([data-coordinator-folded])')) result.push('conversation');
  if (document.querySelector('[data-strips][aria-pressed="true"]')) result.push('timeline');
  return result.length ? result : ['unknown'];
}

export function inputAction(event: Event): Action | undefined {
  if (!(event.target instanceof Element)) return;
  const target = event.target;
  if (event.type === 'input') return target.matches('[data-search-input]') ? 'search-input' : undefined;
  if (target.closest('[data-list-next]')) return 'intent-task-next';
  if (target.closest('[data-list-previous]')) return 'intent-task-previous';
  if (target.closest('[data-reader-back]')) return 'intent-reader-back';
  if (target.closest('[data-read], [data-result], [data-task-card-open]')) return 'intent-task-open';
  const timeline = target.closest('[data-strips]');
  if (timeline) {
    if (timeline.getAttribute('aria-pressed') === 'true') return 'intent-timeline-close';
    if (timeline.getAttribute('aria-pressed') === 'false') return 'intent-timeline-open';
    return;
  }
  const body = target.closest('[data-report-key] > article > div > button[aria-expanded]');
  if (body?.getAttribute('aria-expanded') === 'true') return 'intent-body-close';
  if (body?.getAttribute('aria-expanded') === 'false') return 'intent-body-open';
}
