import type { TFunction } from 'i18next';
import type { Document } from './document';

/**
 * Both input surfaces say the recipients in the draft, independently of the task being viewed. One project says so:
 * its label already names it. An automation's badge says what may be asked of it, and so does the automations face
 * (`automations`) with nothing named.
 */
export function inputPlaceholder(doc: Document, t: TFunction<'ui'>, isProject: (id: string) => boolean, folded = false, automations = false): string {
  let first: string | undefined;
  for (const block of doc.content) {
    for (const node of block.content ?? []) {
      // What to ask about an automation: a change to the one named, or a new one, by example.
      if (node.type === 'automationLabel') return node.attrs.id === 'new' ? t('ui:input.placeholderNewAutomation') : t('ui:input.placeholderAutomation', { id: node.attrs.id });
      if (node.type !== 'taskLabel') continue;
      if (first === undefined) first = node.attrs.id;
      else if (node.attrs.id !== first) return t('ui:input.placeholderTasks', { id: first });
    }
  }
  // On the automations face, with nothing named, what is asked here is about automations.
  if (first === undefined) return t(automations ? 'ui:input.placeholderAutomations' : folded ? 'ui:input.placeholderFolded' : 'ui:input.placeholder');
  return isProject(first) ? t('ui:input.placeholderProject') : t('ui:input.placeholderTask', { id: first });
}
