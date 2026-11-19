import { diffArrays } from 'diff';
import type { Node } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';

// Positions belong to content, not its formatting. Attributes distinguish atoms
// such as two answers of the same node type.
function contentTokens(doc: Node): (number | string)[] {
  const tokens: (number | string)[] = [];
  const append = (node: Node) => {
    if (node.isText) {
      for (let i = 0; i < node.text!.length; i++) tokens.push(node.text!.charCodeAt(i));
    } else {
      tokens.push(JSON.stringify([node.type.name, node.attrs]));
      if (!node.isLeaf) { node.forEach(append); tokens.push(`/${node.type.name}`); }
    }
  };
  doc.forEach(append);
  return tokens;
}

/** Reflect an outside document through edits, so selections map with the content. */
export function documentUpdate(state: EditorState, next: Node): Transaction | null {
  if (state.doc.eq(next)) return null;
  const tr = state.tr, changes: { fromA: number; toA: number; fromB: number; toB: number }[] = [];
  let a = 0, b = 0;
  // Keep common regions even in long drafts. ChangeSet's bounded diff can turn
  // separated changes around >2500 tokens into one replacement of their middle.
  for (const part of diffArrays(contentTokens(state.doc), contentTokens(next))) {
    if (part.added || part.removed) {
      let change = changes.at(-1);
      if (!change || change.toA !== a || change.toB !== b) {
        changes.push(change = { fromA: a, toA: a, fromB: b, toB: b });
      }
      if (part.added) b += part.count; else a += part.count;
      change.toA = a; change.toB = b;
    } else {
      a += part.count; b += part.count;
    }
  }
  for (const change of changes.reverse()) tr.replace(change.fromA, change.toA, next.slice(change.fromB, change.toB));
  // Mark steps leave positions intact. Apply their final state in this same
  // transaction, so the view never sees an intermediate unformatted document.
  if (!tr.doc.eq(next)) {
    tr.removeMark(0, tr.doc.content.size);
    next.descendants((node, pos) => {
      if (node.isInline) for (const mark of node.marks) tr.addMark(pos, pos + node.nodeSize, mark);
    });
  }
  // Formatting from the canonical document is bookkeeping, not another undo
  // press after typing. Content changes (including answer chips) keep history.
  if (!changes.length) tr.setMeta('addToHistory', false);
  return tr;
}
