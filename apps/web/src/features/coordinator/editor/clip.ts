/** The coordinator's words as clipboard pieces (lib/clipboard.ts), and pasted pieces back as the input's labels. */
import type { JSONContent } from '@tiptap/core';
import { taskPiece, type Piece } from '@/lib/clipboard';
import type { MessagePart } from './wire';
import type { Answer, Inline, Skill } from './document';

/**
 * A sent message (its parts as `splitMessage` reads them): each task is a reference (`taskPiece`), named by its title
 * when one is read here; a skill keeps its mark. An answer is its words (`1-Name`, the stop token): it belongs to the
 * question it answered, which a paste cannot hold.
 */
export function messagePieces(parts: readonly MessagePart[]): Piece[] {
  return parts.map((part): Piece => {
    if (part.kind === 'task') return taskPiece({ id: part.id!, title: part.title ?? '' });
    if (part.kind === 'skill') return { kind: 'skill', invocation: part.text[0] as '/' | '$', name: part.text.slice(1) };
    return { kind: 'text', text: part.text };
  });
}

/**
 * What the input holds (paragraphs of labels and words, as JSON). A label stands apart from what touches it by a space,
 * as it does when sent (`serialize`); context labels are not words. A question's answer is its words
 * (`1-Option1`), kept by this page (`keepCopy`): it belongs to the question it answers, which only this page knows.
 */
export function contentPieces(blocks: readonly JSONContent[]): { pieces: Piece[]; answers: Answer[] } {
  const pieces: Piece[] = [], answers: Answer[] = [];
  let apart = false;
  const text = (value: string) => {
    if (apart && value && !/^\s/.test(value)) value = ' ' + value;
    apart = false;
    const last = pieces.at(-1);
    if (last?.kind === 'text') last.text += value; else if (value) pieces.push({ kind: 'text', text: value });
  };
  const label = (piece: Piece) => {
    const last = pieces.at(-1);
    if (last && (last.kind !== 'text' || !/\s$/.test(last.text))) text(' ');
    pieces.push(piece);
    apart = true;
  };
  blocks.forEach((block, at) => {
    if (at) { apart = false; text('\n'); }
    for (const node of (block.type === 'paragraph' ? block.content ?? [] : [block]) as Inline[]) {
      if (node.type === 'text') text(node.text);
      else if (node.type === 'hardBreak') { apart = false; text('\n'); }
      else if (node.type === 'taskLabel') label(taskPiece(node.attrs));
      else if (node.type === 'skillLabel') label({ kind: 'skill', invocation: node.attrs.invocation, name: node.attrs.name });
      else if (node.type === 'answerLabel') label({ kind: 'kept', text: node.attrs.answer, at: answers.push(node.attrs) - 1 });
    }
  });
  return { pieces, answers };
}

/**
 * Pasted pieces as the input's paragraphs. A task is its label when it is known here (its title as known here); a
 * skill when the coordinator's skills have it now (as they have it); a kept piece when this page kept it, as the same
 * words (`keptAnswer`). Any other is the words it was shown as.
 */
export function piecesContent(pieces: readonly Piece[], task: (address: string) => { id: string; title: string } | undefined,
  skill: (name: string) => Skill | undefined, kept: (copy: string, at: number, text: string) => Answer | undefined): JSONContent[] {
  const blocks: JSONContent[][] = [[]];
  const text = (value: string) => value.split('\n').forEach((line, at) => {
    if (at) blocks.push([]);
    if (line) blocks.at(-1)!.push({ type: 'text', text: line });
  });
  for (const piece of pieces) {
    if (piece.kind === 'text') { text(piece.text); continue; }
    if (piece.kind === 'task') {
      const known = task(piece.address);
      if (known) blocks.at(-1)!.push({ type: 'taskLabel', attrs: { id: known.id, title: known.title, auto: false } });
      else text(piece.label);
      continue;
    }
    if (piece.kind === 'kept') {
      const answer = piece.copy ? kept(piece.copy, piece.at, piece.text) : undefined;
      if (answer) blocks.at(-1)!.push({ type: 'answerLabel', attrs: answer }); else text(piece.text);
      continue;
    }
    const known = skill(piece.name);
    if (known) { const { description: _, ...attrs } = known; blocks.at(-1)!.push({ type: 'skillLabel', attrs }); }
    else text(piece.invocation + piece.name);
  }
  return blocks.map(content => ({ type: 'paragraph', ...(content.length ? { content } : {}) }));
}

/**
 * The answers of the input's last copy, kept in this page under a random key the clipboard carries. Pasted back, an
 * answer is its label again only from that copy, at its place in it, as the same words; the words around it, and its
 * task and skills, are what is pasted, looked up as any paste.
 */
let kept: { key: string; answers: readonly Answer[] } | null = null;
export function keepCopy(answers: readonly Answer[]): string {
  const key = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  kept = { key, answers };
  return key;
}
export const keptAnswer = (key: string, at: number, text: string): Answer | undefined => {
  const answer = kept?.key === key ? kept.answers[at] : undefined;
  return answer?.answer === text ? answer : undefined;
};
