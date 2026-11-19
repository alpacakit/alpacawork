import type { TFunction } from 'i18next';
import type { Document } from './document';

/**
 * Both input surfaces say the recipients in the draft, independently of the task being viewed. One project says so:
 * its label already names it.
 */
export function inputPlaceholder(doc: Document, t: TFunction<'ui'>, isProject: (id: string) => boolean, folded = false): string {
  let first: string | undefined;
  for (const block of doc.content) {
    for (const node of block.content ?? []) {
      if (node.type !== 'taskLabel') continue;
      if (first === undefined) first = node.attrs.id;
      else if (node.attrs.id !== first) return t('ui:input.placeholderTasks', { id: first });
    }
  }
  if (first === undefined) return t(folded ? 'ui:input.placeholderFolded' : 'ui:input.placeholder');
  return isProject(first) ? t('ui:input.placeholderProject') : t('ui:input.placeholderTask', { id: first });
}
