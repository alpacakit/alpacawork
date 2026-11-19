import { createElement, type ComponentType } from 'react';
import { ReactRenderer, type Editor } from '@tiptap/react';
import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { sizeObserver } from '@/lib/surface';

export type LabelProps = Pick<NodeViewRendererProps, 'editor' | 'node' | 'getPos'>;
type FaceProps = LabelProps & { component: ComponentType<LabelProps> };
function Face({ component, ...props }: FaceProps) {
  return <>{createElement(component, props)}<span data-label-baseline aria-hidden="true" style={{ display: 'inline-block', width: 0, height: 0 }} /></>;
}

// A real transparent image avoids the browser's missing-image frame. Its alt is empty so native IME offsets see
// one object replacement character, just as ProseMirror sees one atom, rather than the label's display text.
const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
type Entry = { slot: HTMLImageElement; face: HTMLElement; getPos: LabelProps['getPos']; node: PMNode };
const surfaces = new WeakMap<Editor, AtomSurface>();

/** The editor's one owner of native atom slots and their faces outside the editable DOM. */
class AtomSurface {
  private entries = new Set<Entry>();
  private layer: HTMLElement | null = null;
  private sizes: ResizeObserver | null = null;
  private changes: MutationObserver | null = null;
  private pending: number | null = null;
  private hint: HTMLElement | null = null;
  private hostWindow: Window | null = null;

  constructor(private view: EditorView) {}

  add(entry: Entry) {
    this.entries.add(entry);
    this.layer?.append(entry.face);
    this.sizes?.observe(entry.face);
    this.schedule();
    return () => {
      this.entries.delete(entry);
      this.sizes?.unobserve(entry.face);
      entry.face.remove();
      this.schedule();
    };
  }

  connect(layer: HTMLElement) {
    this.disconnect();
    this.layer = layer;
    this.hostWindow = layer.ownerDocument.defaultView;
    for (const entry of this.entries) layer.append(entry.face);
    this.hint = layer.ownerDocument.createElement('span');
    this.hint.className = 'relative col-start-1 row-start-1 self-start justify-self-start pointer-events-none truncate text-soft';
    this.hint.hidden = true;
    layer.append(this.hint);
    this.sizes = sizeObserver(layer, this.schedule);
    this.sizes.observe(this.view.dom);
    for (const entry of this.entries) this.sizes.observe(entry.face);
    this.changes = new MutationObserver(this.schedule);
    this.changes.observe(layer, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    layer.addEventListener('mousedown', this.press);
    this.hostWindow?.addEventListener('resize', this.schedule);
    this.measure();
    return () => this.disconnect();
  }

  disconnect() {
    const window = this.hostWindow;
    if (this.pending !== null) window?.cancelAnimationFrame(this.pending);
    this.pending = null;
    this.sizes?.disconnect(); this.sizes = null;
    this.changes?.disconnect(); this.changes = null;
    this.layer?.removeEventListener('mousedown', this.press);
    window?.removeEventListener('resize', this.schedule);
    this.hint?.remove(); this.hint = null;
    this.layer = null;
    this.hostWindow = null;
  }

  schedule = () => {
    if (!this.layer || this.pending !== null) return;
    this.pending = this.hostWindow!.requestAnimationFrame(() => {
      this.pending = null;
      this.measure();
    });
  };

  private measure() {
    const layer = this.layer;
    if (!layer || !layer.isConnected || this.view.isDestroyed) return;
    const slot = this.view.dom.querySelector<HTMLElement>('[data-draft-hint]'), hint = this.hint;
    // With no labels or inline hint there is nothing to align with the editor.
    if (!this.entries.size && !slot) {
      if (hint) { hint.hidden = true; hint.removeAttribute('data-placeholder'); }
      return;
    }
    const style = getComputedStyle(this.view.dom);
    const font = style.font, letterSpacing = style.letterSpacing;
    layer.style.font = font;
    layer.style.letterSpacing = letterSpacing;
    const entries = [...this.entries].sort((a, b) => (a.getPos() ?? 0) - (b.getPos() ?? 0));
    // A label inserted in the middle is also in the middle of the accessible/action order outside the editor.
    entries.forEach(({ face }, i) => { if (layer.children[i] !== face) layer.insertBefore(face, layer.children[i] ?? null); });
    // Measure a full text line and its baseline in each face. The image occupies exactly that same inline box.
    // This preserves the surrounding line's baseline and height, including after a wrap and a font-size change.
    // Read every face before sizing any slot, so each label does not force the next layout.
    const sizes = [];
    for (const { slot, face } of entries) {
      const baseline = face.querySelector<HTMLElement>('[data-label-baseline]');
      if (!baseline || !slot.isConnected) continue;
      const box = face.getBoundingClientRect(), at = baseline.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      sizes.push({ slot, box, at });
    }
    for (const { slot, box, at } of sizes) {
      slot.style.width = `${box.width}px`;
      slot.style.height = `${box.height}px`;
      slot.style.verticalAlign = `${at.top - box.bottom}px`;
    }
    const origin = layer.getBoundingClientRect();
    // Slot layout is now final; read all positions before placing the faces.
    const positions = entries.map(({ slot, face }) => ({ face, box: slot.getBoundingClientRect() }));
    for (const { face, box } of positions) {
      // Native caret projection ignores transforms. Relative offsets keep the face in the same normal flow as
      // the editable root, and supply the actual layout coordinates to that projection.
      face.style.left = `${box.left - origin.left}px`;
      face.style.top = `${box.top - origin.top}px`;
    }
    if (hint) {
      const box = slot?.getBoundingClientRect();
      const root = this.view.dom.getBoundingClientRect();
      const room = box ? Math.max(0, Math.floor(root.right - Number.parseFloat(style.paddingRight) - box.right)) : 0;
      hint.hidden = !box || room < 4 * Number.parseFloat(style.fontSize);
      if (box && !hint.hidden) {
        const text = slot!.getAttribute('data-draft-hint')!;
        hint.dataset.placeholder = text;
        if (hint.textContent !== text) hint.textContent = text;
        hint.style.left = `${box.right - origin.left}px`;
        hint.style.top = `${box.top - origin.top}px`;
        hint.style.width = `${room}px`;
      } else hint.removeAttribute('data-placeholder');
    }
  }

  private press = (event: MouseEvent) => {
    if (event.button !== 0 || !this.layer) return;
    event.preventDefault();
    // The face's controls retain their actions and the current caret. Its padding belongs to the writing surface.
    if ((event.target as Element).closest('button, a, input, select, textarea')) return;
    const layer = this.layer, before = layer.style.visibility;
    let at: ReturnType<EditorView['posAtCoords']>;
    try {
      layer.style.visibility = 'hidden';
      at = this.view.posAtCoords({ left: event.clientX, top: event.clientY });
    } finally { layer.style.visibility = before; }
    if (!at) return;
    this.view.dispatch(this.view.state.tr.setSelection(Selection.near(this.view.state.doc.resolve(at.pos))));
    this.view.focus();
  };
}

export function atomSurface(editor: Editor, view = editor.view) {
  let surface = surfaces.get(editor);
  if (!surface) { surface = new AtomSurface(view); surfaces.set(editor, surface); }
  return surface;
}

export function labelView(component: ComponentType<LabelProps>, text: (node: PMNode) => string) {
  return (props: NodeViewRendererProps): NodeView => {
    const { editor, view, getPos } = props;
    const surface = atomSurface(editor, view);
    const slot = view.dom.ownerDocument.createElement('img');
    slot.src = TRANSPARENT; slot.alt = ''; slot.draggable = false;
    slot.dataset.labelSlot = props.node.type.name;
    slot.setAttribute('role', 'img'); slot.setAttribute('aria-label', text(props.node));
    slot.className = 'inline-block max-w-none border-0 p-0 outline-none';
    const renderer = new ReactRenderer(Face, { editor, as: 'span', props: { component, editor, node: props.node, getPos },
      className: 'relative col-start-1 row-start-1 self-start justify-self-start w-max pointer-events-auto' });
    renderer.element.dataset.labelFace = '';
    renderer.element.style.whiteSpace = 'normal';
    const entry: Entry = { slot, face: renderer.element, node: props.node, getPos };
    const remove = surface.add(entry);
    return {
      dom: slot,
      update(node) {
        if (node.type !== entry.node.type) return false;
        entry.node = node;
        slot.setAttribute('aria-label', text(node));
        renderer.updateProps({ node });
        surface.schedule();
        return true;
      },
      ignoreMutation: mutation => mutation.type !== 'selection',
      destroy: () => { remove(); renderer.destroy(); },
    };
  };
}
