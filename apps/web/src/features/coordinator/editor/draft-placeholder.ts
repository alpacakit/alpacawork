import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { hasInlineContent } from './document';

/** A draft's hint has no document position or layout width, so native caret hit testing stays the browser's. */
export function draftPlaceholder(text: () => string) {
  return Extension.create({ name: 'draftPlaceholder', addProseMirrorPlugins: () => [new Plugin({
    props: { decorations: state => {
      let content = false, lastLabel: number | null = null;
      state.doc.descendants((node, pos) => {
        if (content) return false;
        content = hasInlineContent(node.type.name, node.text);
        if (['taskLabel', 'replyLabel'].includes(node.type.name)) lastLabel = pos;
        return !content;
      });
      if (content) return null;
      return DecorationSet.create(state.doc, [lastLabel === null
        ? Decoration.node(0, state.doc.firstChild!.nodeSize, { 'data-placeholder': text(),
          // One line, cut with "…" where the input is narrower than it (a 320px phone): drawn out of the flow, it never
          // pushes the caret nor wraps under the tools.
          class: 'relative before:pointer-events-none before:absolute before:inset-x-0 before:truncate before:text-soft before:content-[attr(data-placeholder)]' })
        : Decoration.node(lastLabel, lastLabel + 1, {
          // The slot is childless. Its visual hint is drawn by the same surface as the label's face.
          'data-draft-hint': text() })]);
    } },
  })] });
}
