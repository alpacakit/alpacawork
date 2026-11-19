import { hasCoarsePointer } from "@/lib/input-capabilities";
import { READER_OPERATION_MARK, afterReaderOperationEdit } from './document';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { LabelPopover, LabelRemove } from '../LabelPopover';
import { ReplyLabel } from '../ReplyLabel';
import { slideChips, stopChipMotion } from './answer-chips';
import { createPortal } from 'react-dom';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Extension, Mark, Node, extensions, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Suggestion, { exitSuggestion } from '@tiptap/suggestion';
import { Plugin, PluginKey, TextSelection, NodeSelection } from '@tiptap/pm/state';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { useTranslation } from 'react-i18next';
import { userTurn } from '@alpacawork/contract';
import { Icon } from '@/components/ui/icon';
import { Message } from '@/components/ui/message';
import { stateLook, TONE } from '@/components/ui/tone';
import { useTaskCard } from '../TaskCard';
import { isComposingKey, observeComposition } from '@/components/ui/composing';
import { useEveryTaskIndex, taskIndex } from '@/data/queries';
import { useWorkspaceSelector } from '@/data/workspace-store';
import { shownInReader, useViewStore } from '@/state/view-store';
import { useEscapeLayer, ESCAPE_LAYER } from '@/lib/escape-layer';
import { useCloseOnPhoneBack } from '@/lib/close-on-back';
import { useSurfaceDocument } from '@/lib/surface';
import { cn } from '@/lib/utils';
import { formatTask, taskTokens, TASK_TRIGGERS, SKILL_TRIGGERS } from './wire';
import { parseDocument, draftDocument, type Document } from './document';
import { useDraftStore } from '@/features/forms/draft-store';
import { draftPlaceholder } from './draft-placeholder';
import { atomSurface, labelView, type LabelProps } from './atom-surface';
import { projectInput } from './input-ownership';
import { documentUpdate } from './document-update';
import { contentPieces, keepCopy, keptAnswer, piecesContent } from './clip';
import { piecesClip, putClip, readPieces, taskPiece } from '@/lib/clipboard';
import { PASTE_AS_FILE_CHARACTERS } from '@/domain/attachments';
import { useInputDraft, registerCoordinatorField, labelContent } from './draft';
import { VOICE_TRANSACTION } from '@/features/reader/VoiceInput';
import { resolveReference, taskAtAddress } from '@/domain/tasks';
import { skillStanding, skillsUnverified, type SkillCatalog } from './skills';
import { LabelFace, SkillMark, TaskLabelText, AnswerLabelText, ProjectLabelText, projectFace } from '../LabelFace';
import { useProjectMarks, type ProjectMark } from '@/data/project-marks';
import { choose, sideways } from './insert-choice';
import { useProjects } from '@/data/queries';
import { ProjectTile } from '@/components/ui/project-tile';
import { CopyButton } from '@/components/ui/copy-button';
import { CountMarks } from '@/features/chrome/ProjectMenu';

/** A label's own way out: the × on it, or its card's Remove. */
const removeLabel = (editor: LabelProps['editor'], getPos: LabelProps['getPos']) => {
  const pos = getPos();
  if (pos !== undefined) editor.chain().focus().deleteRange({ from: pos, to: pos + 1 }).run();
};
/** What a # or / does not start a list after: it is the end of a word, a path or an address. */
const INSIDE_WORD = /[A-Za-z0-9_./\\:$#@-]/;

function TaskBadge({ node, editor, getPos }: LabelProps) {
  const { t } = useTranslation('ui');
  const id = String(node.attrs.id);
  const card = useTaskCard(id, () => useViewStore.getState().openTask(id, { reader: true }), node.attrs.title);
  const mark = useProjectMarks().get(id);
  const { look } = card;
  const remove = () => removeLabel(editor, getPos);
  if (mark) return <span className="inline" data-label="task" data-label-project>
    <ProjectLabelCard mark={mark} remove={remove} />
  </span>;
  return <span className="inline" data-label="task">
    <LabelPopover kind="task" name={id}
      face={<TaskLabelText id={id} title={card.task?.title ?? node.attrs.title} mark={look && <Icon name={look.icon} className={cn('size-3', TONE[look.tone])} />} />}
      tail={<LabelRemove name={t('coordinatorCard.removeTask', { id })} remove={remove} />}
      header={card.header}
      actions={close => <>{card.openButton(close)}
        <button type="button" className="px-2 py-1 text-muted" onClick={remove}>{t('input.remove')}</button></>}>
      {card.body}
    </LabelPopover>
  </span>;
}
/**
 * A project's label and its card. The card says it is a project, with the numbers its menu row has (Your turn,
 * Working), its name and ID (copied as a task's reference is, taskPiece), and opens the project's list or takes the label
 * out.
 */
function ProjectLabelCard({ mark, remove }: { mark: ProjectMark; remove: () => void }) {
  const { t } = useTranslation('ui');
  const counts = useProjects().find(({ id }) => id === mark.id)?.counts;
  return <LabelPopover kind="project" name={mark.name} face={<ProjectLabelText mark={mark} />} faceStyle={projectFace(mark)}
    tail={<LabelRemove name={t('coordinatorCard.removeTask', { id: mark.id })} remove={remove} />}
    header={<><ProjectTile name={mark.name} color={mark.color} size={18} />{t('input.project')}{counts && <CountMarks counts={counts} className="ml-auto" />}</>}
    actions={close => <><button type="button" className="rounded-sm border border-line px-2 py-1" onClick={() => { close(); useViewStore.getState().setProject(mark.id); }}>{t('input.openProject')}</button>
      <button type="button" className="px-2 py-1 text-muted" onClick={remove}>{t('input.remove')}</button></>}>
    <strong dir="auto" className="mt-1 block">{mark.name}</strong>
    <span data-label-card-id className="mt-0.5 flex items-center gap-1 text-xs text-muted tabular-nums">{mark.id}
      <CopyButton clip={() => piecesClip([taskPiece({ id: mark.id, title: mark.name })])} label={t('input.copyProject', { id: mark.id })} className="size-6" /></span>
  </LabelPopover>;
}
function ReplyBadge({ node, editor, getPos }: LabelProps) {
  return <span className="inline" contentEditable={false}>
    <ReplyLabel reply={{ id: String(node.attrs.id), answeredAt: String(node.attrs.answeredAt), head: '' }}
      remove={() => removeLabel(editor, getPos)} />
  </span>;
}

function AnswerBadge({ node, editor, getPos }: LabelProps) {
  const { t } = useTranslation('ui');
  const held = useWorkspaceSelector(data => taskIndex(data.tasks, data.info.counts.children).byId.get(String(node.attrs.task))?.state === 'held');
  return <span className="inline" data-label="answer" data-held={held || undefined}
    data-answer-task={String(node.attrs.task)} data-answer-question={String(node.attrs.question)} data-answer-n={String(node.attrs.n)} data-answer-answer={String(node.attrs.answer)}>
    <LabelFace kind="answer" contentEditable={false} title={`${node.attrs.task} ${node.attrs.answer}`}>
      <AnswerLabelText n={String(node.attrs.n)} name={String(node.attrs.name)} />
      <button type="button" aria-label={t('input.skipAnswer')} onMouseDown={e => e.preventDefault()}
        onClick={() => { if (getPos() !== undefined) slideChips(); removeLabel(editor, getPos); }} className="grid size-[18px] place-items-center rounded-full text-muted hover:bg-hover"><Icon name="close" className="size-3" /></button>
    </LabelFace>
  </span>;
}
const SkillAvailability = createContext<SkillCatalog | null>(null);
function SkillBadge({ node }: LabelProps) {
  const { t } = useTranslation('ui');
  const catalog = useContext(SkillAvailability);
  // Still being read, a catalog has nothing to say about the skill yet.
  const warning = !catalog || catalog.status === 'loading' ? undefined : { usable: undefined, gone: t('input.skillsChanged'), unknown: skillsUnverified(t, catalog) }[skillStanding(catalog, String(node.attrs.name))];
  return <span className="inline" data-label="skill"><LabelFace kind="skill" contentEditable={false} title={warning} className={cn(warning && 'border-dashed border-warn text-warn')}>
    <SkillMark />{node.attrs.name}</LabelFace></span>;
}
const atom = { group: 'inline', inline: true, atom: true, selectable: false, draggable: false } as const;
function labelNode(name: string, attrs: Record<string, unknown>, view: Parameters<typeof labelView>[0], text: (attrs: Record<string, any>) => string) {
  return Node.create({ name, ...atom,
    addAttributes: () => Object.fromEntries(Object.entries(attrs).map(([key, value]) => [key, { default: value, rendered: false }])),
    // A label is drawn by its view and read back from the clipboard only through `readPieces` (editor/clip.ts): no
    // HTML is parsed into a label, so nothing pasted is taken for one unchecked.
    renderHTML: ({ node }) => ['span', { 'data-editor-label': name }, text(node.attrs)],
    renderText: ({ node }) => text(node.attrs), addNodeView: () => labelView(view, node => text(node.attrs)),
  });
}
const TaskLabel = labelNode('taskLabel', { id: '', title: '' }, TaskBadge, a => formatTask(a.id, a.title));
const AnswerLabel = labelNode('answerLabel', { question: '', task: '', n: '', name: '', answer: '' }, AnswerBadge, a => `${a.task} ${a.answer}`);
const ReplyNode = labelNode('replyLabel', { id: '', answeredAt: '' }, ReplyBadge, () => '');
const SkillLabel = labelNode('skillLabel', { name: '', invocation: '/' }, SkillBadge, a => `${a.invocation}${a.name}`);

export const composing = (event: KeyboardEvent, view?: EditorView) => !!view?.composing || isComposingKey(event);
// Tiptap's Mac Ctrl+A/E move to the textblock's ends, skipping hardBreaks.
// Keep its platform detection and other editing keys, but let the browser own
// native line navigation, including soft wraps and inline labels.
const inputKeymap = extensions.Keymap.extend({
  addKeyboardShortcuts() {
    const shortcuts = { ...this.parent?.() };
    delete shortcuts['Ctrl-a'];
    delete shortcuts['Ctrl-e'];
    return shortcuts;
  },
});
const autoKey = new PluginKey<{ pos: number; text: string; cursor: number } | null>('typed-task');
/** The input's last change was a paste. */
const pastedKey = new PluginKey<boolean>('pasted');
function typedTasks(lookup: (id: string) => { id: string; title: string } | undefined) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reverted: string | null = null;
  const convert = (view: EditorView) => {
    if (view.isDestroyed || view.composing || !view.state.selection.empty || !view.editable) return;
    const { state } = view, { $from } = state.selection;
    // Prefix from the document root preserves quote/fence state across paragraphs.
    // Inline labels stay opaque, as in the document's send-time projection.
    const before = state.doc.textBetween(0, $from.pos, '\n', '\ufffc');
    if (before === reverted) return;
    // Conversion requires a bare ID ending one UTF-16 unit before the caret.
    // With no such suffix, skip the full lexer; candidates still need its
    // paragraph-spanning quote, fence and URL rules below.
    if (!/[TtＴｔPpＰｐ][0-9０-９]+[\s\S]$/.test(before)) return;
    const match = taskTokens(before, lookup).at(-1);
    if (!match || match.to !== before.length - 1 || match.to - match.from !== match.text.length) return;
    const task = lookup(match.id);
    if (!task) return;
    const end = $from.pos - 1, start = end - match.text.length;
    const tr = state.tr.replaceWith(start, end, state.schema.nodes.taskLabel!.create({ id: task.id, title: task.title }));
    view.dispatch(tr.setMeta(autoKey, { pos: start, text: match.text, cursor: tr.selection.from }));
  };
  return Extension.create({ name: 'typedTasks', priority: 1100,
    addProseMirrorPlugins: () => [new Plugin({ key: autoKey,
      state: { init: () => null, apply: (tr, prior) => tr.getMeta(autoKey) ?? (tr.docChanged || tr.selectionSet ? null : prior) },
      view: () => ({ update: (view, prior) => {
        if (view.state.doc.eq(prior.doc) || view.state.tr.getMeta(autoKey)) return;
        clearTimeout(timer);
        // Typing makes a label by ID format; a paste keeps its own pieces.
        if (!pastedKey.getState(view.state)) timer = setTimeout(() => convert(view), 60);
      }, destroy: () => clearTimeout(timer) }),
    }), new Plugin({ key: pastedKey,
      state: { init: () => false, apply: (tr, prior) => tr.getMeta('uiEvent') === 'paste' || (!tr.docChanged && prior) } })],
    addKeyboardShortcuts: () => ({ Backspace: ({ editor }) => {
      const last = autoKey.getState(editor.state);
      if (!last || !editor.state.selection.empty || editor.state.selection.from !== last.cursor) return false;
      const tr = editor.state.tr.replaceWith(last.pos, last.pos + 1, editor.state.schema.text(last.text));
      const restored = tr.doc.resolve(last.pos + last.text.length + (last.cursor - last.pos - 1));
      reverted = tr.doc.textBetween(0, restored.pos, '\n', '\ufffc');
      editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, last.pos + last.text.length + (last.cursor - last.pos - 1))));
      return true;
    } }),
  });
}

/** A # item is a task, or a project (`project`), drawn in the row of project labels on top of the list. */
type Item = { id: string; label: ReactNode; apply: (editor: Editor, range: { from: number; to: number }) => void; project?: { name: string } };
type Menu = { key: PluginKey; kind: 'task' | 'skill'; query: string; items: Item[]; index: number; pick: (item: Item) => void };
const fold = (s: string) => s.normalize('NFKC').toLowerCase();
/**
 * Whether Enter breaks the line here, and the input's hint says so. Pointer precision is a conservative proxy, not
 * keyboard detection: a coarse iPad with an external keyboard keeps Enter for line breaks; its explicit Cmd/Ctrl+Enter
 * shortcut still sends.
 */
const enterBreaksLine = (at: globalThis.Document) => at.defaultView ? hasCoarsePointer(at.defaultView) : false;
function suggestions(kind: Menu['kind'], char: string, items: (query: string) => Item[], show: (menu: Menu | null) => void, current: () => Menu | null) {
  const key = new PluginKey(`${kind}-${char}`);
  return Extension.create({ name: `${kind}-${char}`, addProseMirrorPlugins() {
    return [Suggestion<Item>({ editor: this.editor, char, pluginKey: key, allowedPrefixes: null,
      allow: ({ state, range }) => !INSIDE_WORD.test(state.doc.textBetween(Math.max(0, range.from - 1), range.from, '\n', '\ufffc')),
      items: ({ query }) => items(query), command: ({ editor, range, props }) => props.apply(editor, range),
      render: () => ({ onStart: p => { const list = items(p.query); show({ key, kind, query: p.query, items: list, index: choose(list, p.query), pick: item => p.command(item) }); },
        onUpdate: p => { const list = items(p.query), before = current(); show({ key, kind, query: p.query, items: list, index: choose(list, p.query, before?.items[before.index]?.id), pick: item => p.command(item) }); },
        onExit: () => show(null), onKeyDown: ({ event, view }) => {
          const menu = current(); if (!menu || composing(event, view)) return false;
          if (event.key === 'Escape') { exitSuggestion(view, key); show(null); return true; }
          if (!menu.items.length) return false;
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { show({ ...menu, index: (menu.index + (event.key === 'ArrowDown' ? 1 : -1) + menu.items.length) % menu.items.length }); return true; }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            const index = sideways(menu.items, menu.index, event.key === 'ArrowRight' ? 1 : -1);
            if (index === null) return false;
            show({ ...menu, index }); return true;
          }
          if (event.key === 'Tab') { menu.pick(menu.items[menu.index]!); return true; }
          return false;
        } }),
    })];
  } });
}
const insert = (type: string, attrs: Record<string, unknown>) => (editor: Editor, range: { from: number; to: number }) => editor.chain().focus().insertContentAt(range, labelContent(type, attrs)).run();

export function LabelEditor({ draft, catalog, onSend, disabled, attaching, tall, placeholder, onLong, editorRef, partial }: {
  draft: ReturnType<typeof useInputDraft>; catalog: SkillCatalog; onSend: () => void; disabled: boolean; attaching: boolean; tall: boolean; placeholder: string;
  onLong: (long: boolean) => void; editorRef: React.RefObject<Editor | null>; partial?: { at: number; text: string };
}) {
  const { t } = useTranslation('ui');
  const index = useEveryTaskIndex();
  // Projects, in their menu's order. With one, every task is its: its row is drawn only once what is typed names it.
  const projects = useProjects();
  // The task the detail panel shows.
  const viewing = useViewStore(shownInReader);
  const latest = useRef({ projects, index, viewing, catalog, draft, onSend, onLong, placeholder, t, disabled, attaching, partial });
  latest.current = { projects, index, viewing, catalog, draft, onSend, onLong, placeholder, t, disabled, attaching, partial };
  const [menu, setMenu] = useState<Menu | null>(null), menuRef = useRef<Menu | null>(null);
  const show = (m: Menu | null) => { menuRef.current = m; setMenu(m); };
  // What was typed narrows the list. The projects lead it, as a row of their labels; of the tasks left, the one
  // the detail panel shows comes first, then the rest in their order.
  const projectItems = (query: string): Item[] => {
    const foldedQuery = fold(query);
    return !query && latest.current.projects.length < 2 ? [] : latest.current.projects
      .filter(project => fold(`${project.id} ${project.title}`).includes(foldedQuery)).map(project => ({ id: project.id, project: { name: project.title },
        apply: insert('taskLabel', { id: project.id, title: project.title }),
        label: <><ProjectTile name={project.title} color={project.color} size={16} /><span dir="auto" className="max-w-[9em] truncate">{project.title}</span></> }));
  };
  const taskItems = (query: string): Item[] => {
    const foldedQuery = fold(query);
    return [...projectItems(query), ...[...latest.current.index.byId.values()].filter(task => task.kind !== 'project' && fold(`${task.id} ${task.title}`).includes(foldedQuery)).sort((a, b) => Number(b.id === latest.current.viewing) - Number(a.id === latest.current.viewing) || Number(!!userTurn(b.ball)) - Number(!!userTurn(a.ball)) || Number(b.id.slice(1)) - Number(a.id.slice(1))).slice(0, 12).map(task => {
      const look = stateLook(task.state, task.ball);
      return { id: task.id, apply: insert('taskLabel', { id: task.id, title: task.title }), label: <><Icon name={look.icon} className={cn('size-4', TONE[look.tone])} /><span className="flex-none text-muted">{task.id}</span><span className="min-w-0 flex-1 truncate">{task.title}</span></> };
    })];
  };
  const skillItems = (query: string): Item[] => {
    const foldedQuery = fold(query);
    return (latest.current.catalog.status === 'ready' ? latest.current.catalog.skills : []).filter(skill => fold(`${skill.name} ${skill.description}`).includes(foldedQuery)).map(skill => ({ id: skill.name, apply: insert('skillLabel', skill), label: <><span className="flex flex-none items-center gap-1.5 font-medium"><SkillMark />{skill.name}</span><span className="min-w-0 flex-1 truncate text-muted">{skill.description}</span></> }));
  };
  useEffect(() => {
    const current = menuRef.current;
    if (current?.kind === 'skill') show({ ...current, items: skillItems(current.query), index: 0 });
  }, [catalog]);
  useEffect(() => {
    const current = menuRef.current;
    if (current?.kind === 'task') { const items = taskItems(current.query); show({ ...current, items, index: choose(items, current.query) }); }
  }, [viewing]);
  const at = useSurfaceDocument();
  const copyOut = (view: EditorView, event: ClipboardEvent, cut: boolean) => {
    if (view.state.selection.empty || !event.clipboardData) return false;
    const content = view.state.selection.content().content.toJSON() as JSONContent[];
    const { pieces, answers } = contentPieces(content);
    putClip(event.clipboardData, piecesClip(pieces, keepCopy(answers)));
    event.preventDefault();
    if (cut && view.editable) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'));
    return true;
  };
  const editor = useEditor({ immediatelyRender: true, content: draft.doc, autofocus: false,
    enableCoreExtensions: { keymap: false },
    extensions: [inputKeymap, StarterKit.configure({ heading: false, bold: false, italic: false, strike: false, code: false, codeBlock: false, blockquote: false, bulletList: false, orderedList: false, listItem: false, listKeymap: false, horizontalRule: false, link: false, underline: false, dropcursor: false, gapcursor: false, trailingNode: false }),
      TaskLabel, AnswerLabel, SkillLabel, ReplyNode,
      Extension.create({ name: 'atomSurface', addProseMirrorPlugins() { const editor = this.editor; return [new Plugin({ view: view => {
        const surface = atomSurface(editor, view);
        return { update: () => surface.schedule(), destroy: () => surface.disconnect() };
      } })]; } }),
      Mark.create({name:READER_OPERATION_MARK,inclusive:false,parseHTML:()=>[],renderHTML:()=>['span',0]}),
      draftPlaceholder(() => latest.current.placeholder),
      typedTasks(id => resolveReference(id, latest.current.index)),
      Extension.create({ name: 'deleteBadge', priority: 1000, addKeyboardShortcuts: () => ({
        Backspace: ({ editor }) => {
          const { selection } = editor.state;
          if (editor.view.composing || !selection.empty || !selection.$from.nodeBefore?.isAtom || selection.$from.nodeBefore.isText) return false;
          return editor.commands.deleteRange({ from: selection.from - 1, to: selection.from });
        },
        Delete: ({ editor }) => {
          const { selection } = editor.state;
          if (editor.view.composing || !selection.empty || !selection.$from.nodeAfter?.isAtom || selection.$from.nodeAfter.isText) return false;
          return editor.commands.deleteRange({ from: selection.from, to: selection.from + 1 });
        },
      }) }),
      ...TASK_TRIGGERS.map(char => suggestions('task', char, taskItems, show, () => menuRef.current)),
      ...SKILL_TRIGGERS.map(char => suggestions('skill', char, skillItems, show, () => menuRef.current)),
      Extension.create({ name: 'voicePreview', addProseMirrorPlugins: () => [new Plugin({ props: { decorations: state => {
        const partial = latest.current.partial;
        if (!partial?.text) return null;
        const pos = Math.max(1, Math.min(partial.at, state.doc.content.size - 1));
        return DecorationSet.create(state.doc, [Decoration.widget(pos, view => {
          const span = view.dom.ownerDocument.createElement('span'); span.textContent = partial.text;
          span.dataset.voicePartial = ''; span.setAttribute('role', 'status'); span.className = 'text-muted'; return span;
        }, { side: -1, key: partial.text })]);
      } } })] }),
      Extension.create({ name: 'atomTextInput', addProseMirrorPlugins: () => [new Plugin({ props: { handleTextInput: (view, _from, to, text) => {
        if (!(view.state.selection instanceof NodeSelection) || !view.state.selection.node.isAtom) return false;
        view.dispatch(view.state.tr.insertText(text, to)); return true;
      } } })] }),
    ],
    editorProps: {
      // Copying and pasting go through the one clipboard (lib/clipboard.ts): out, the selection's labels as references;
      // in, references looked up here. Files and a text long enough to be kept as one are the input's attachments.
      handleDOMEvents: { copy: (view, event) => copyOut(view, event, false), cut: (view, event) => copyOut(view, event, true) },
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        if (!data) return false;
        // Files, and a text long enough to be kept whole, are the input's attachments (CoordinatorInput's paste) alone.
        // While nothing can be attached (serve out of reach), such a text is written in as text, not lost.
        if (data.files.length || latest.current.attaching && [...data.getData('text/plain')].length > PASTE_AS_FILE_CHARACTERS) return true;
        const pieces = readPieces(data, view.dom.ownerDocument);
        if (!pieces) return false;
        const { index, catalog } = latest.current;
        const blocks = piecesContent(pieces, address => taskAtAddress(address, index) ?? resolveReference(address, index),
          name => catalog.status === 'ready' ? catalog.skills.find(skill => skill.name === name) : undefined, keptAnswer);
        const fragment = Fragment.fromArray(blocks.map(block => view.state.schema.nodeFromJSON(block)));
        view.dispatch(view.state.tr.replaceSelection(new Slice(fragment, 1, 1)).scrollIntoView().setMeta('uiEvent', 'paste'));
        return true;
      },
      // The words start where the tool row's first mark does (inputTool's 32px or a finger's 44px, in the row's 8px), so what is
      // written and the attach button under it share one left edge; above them the frame keeps about as much as at their side.
      attributes: () => ({ title: latest.current.t(enterBreaksLine(at) ? 'ui:input.touchEnterHint' : 'ui:input.enterHint'), role: 'textbox', 'aria-multiline': 'true', 'aria-label': t('coordinatorCard.sendTo'), 'data-one-input': '', class: 'min-h-control-md px-4 pt-3 pb-1 text-base outline-none narrow:px-5.5 narrow:pt-4 pointer-coarse:px-5.5 pointer-coarse:pt-4' }),
      handleKeyDown: (view, event) => {
        if (event.key !== 'Enter' || composing(event, view) || event.shiftKey) return false;
        const shortcut = event.metaKey || event.ctrlKey;
        // Direct editor props run before suggestion plugins and StarterKit.
        // Enter belongs to the chooser while it is open, including no matches.
        if (!shortcut && menuRef.current) {
          const menu = menuRef.current;
          event.preventDefault();
          if (menu.items.length) menu.pick(menu.items[menu.index]!);
          return true;
        }
        if (!shortcut && enterBreaksLine(view.dom.ownerDocument)) return false;
        event.preventDefault();
        if (!latest.current.disabled) latest.current.onSend();
        return true;
      },
    },
    onUpdate: ({ editor, transaction }) => {
      const doc = afterReaderOperationEdit(parseDocument(editor.getJSON()), transaction.before, transaction.mapping);
      latest.current.draft.change(() => doc, !!transaction.getMeta(VOICE_TRANSACTION), { before: transaction.before, mapping: transaction.mapping });
      latest.current.onLong(editor.view.dom.scrollHeight > 112);
    },
  });
  useLayoutEffect(() => { observeComposition(at); if (editor && !editor.isDestroyed) editor.view.updateRoot(); }, [at, editor]);
  useEffect(() => { editorRef.current = editor; return () => { editorRef.current = null; }; }, [editor, editorRef]);
  useEffect(() => { if (editor && !editor.isDestroyed) editor.setEditable(!disabled); }, [editor, disabled]);
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const commit = () => {
      const current = useDraftStore.getState().entries[draft.key];
      if (!current || editor.isDestroyed) return;
      const doc = editor.state.schema.nodeFromJSON(draftDocument(projectInput(useDraftStore.getState().entries, draft.key, current.values)!));
      const update = documentUpdate(editor.state, doc);
      if (update) editor.view.dispatch(update.setMeta('preventUpdate', true));
    };
    commit();
    const release = registerCoordinatorField(editor.view.dom, commit);
    return release;
  }, [editor, draft.key, draft.doc, at]);
  const labelLayer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (editor && labelLayer.current) return atomSurface(editor).connect(labelLayer.current); }, [editor, at]);
  // Ten lines, or most of the screen made tall; never more than the room the screen's foot gives it (placeFoot).
  useEffect(() => { if (editor && !editor.isDestroyed) { editor.view.dispatch(editor.state.tr); } }, [editor, tall, placeholder, partial?.text, partial?.at]);
  const closeMenu = () => { if (editor && menuRef.current) exitSuggestion(editor.view, menuRef.current.key); show(null); return true; };
  useEscapeLayer(!!menu, ESCAPE_LAYER.input, closeMenu);
  useCloseOnPhoneBack(!!menu, closeMenu);
  const frame = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null);
  // The list is the input's own popup: a press outside it and the words takes the press for itself and closes it, the
  // words (its # or / too) staying as written. It ends here, not by whatever else rewrites the draft. A press that opens
  // a Task in the panel is not away: the list follows the panel.
  useEffect(() => {
    if (!menu) return;
    const away = (event: PointerEvent) => {
      // Its own window's nodes too (picture-in-picture), so no instanceof of this window's classes.
      const target = event.target as globalThis.Node | null;
      const opens = (target as Partial<globalThis.Element> | null)?.closest?.('[data-read]');
      if (target && !opens && !list.current?.contains(target) && !frame.current?.contains(target)) closeMenu();
    };
    at.addEventListener('pointerdown', away, true);
    return () => at.removeEventListener('pointerdown', away, true);
  }, [!!menu, at, editor]);
  const [position, setPosition] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!menu || !frame.current) return;
    const view = at.defaultView!;
    const place = () => {
      const box = frame.current!.getBoundingClientRect(), width = Math.min(view.innerWidth - 16, Math.max(box.width, 380));
      const next = { left: Math.max(8, Math.min(box.left, view.innerWidth - width - 8)), bottom: view.innerHeight - box.top + 6, width, maxHeight: Math.max(100, box.top - 16) };
      setPosition(previous => previous.left === next.left && previous.bottom === next.bottom && previous.width === next.width && previous.maxHeight === next.maxHeight ? previous : next);
    };
    place(); view.addEventListener('resize', place); at.addEventListener('scroll', place, true);
    return () => { view.removeEventListener('resize', place); at.removeEventListener('scroll', place, true); };
  }, [!!menu, menu?.items.length, at]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [menu?.index]);
  useLayoutEffect(() => {
    const root = editor?.view.dom.closest('[data-label-editor]');
    return () => { if (root) stopChipMotion(root); };
  }, [editor]);

  return <div ref={frame} className="relative flex min-h-0 min-w-0 flex-col [&_.ProseMirror_p]:m-0">
    <div data-label-editor className="grid min-h-control-md min-w-0 overflow-y-auto text-base" style={{ maxHeight: `min(${tall ? '65dvh' : 'calc(10lh + 16px)'}, var(--coordinator-editor-room, 100dvh))` }}>
      <SkillAvailability value={catalog}><EditorContent editor={editor} className="col-start-1 row-start-1 min-w-0" /></SkillAvailability>
      <div ref={labelLayer} data-label-layer className="pointer-events-none col-start-1 row-start-1 grid min-h-0 min-w-0 [contain:size]" />
    </div>
    {menu && createPortal(<div ref={list} role="listbox" aria-label={t(menu.kind === 'task' ? 'input.tasks' : 'input.skills')} style={position} onMouseDown={e => e.preventDefault()} className="fixed z-(--layer-popover) overflow-y-auto rounded-md border border-lit-line bg-raised py-1 text-sm text-ink shadow-float">
      <div className="px-3 py-1 text-xs text-muted">{t(menu.kind === 'task' ? 'input.tasks' : 'input.skills')}</div>
      {!menu.items.length && (menu.kind === 'skill' && catalog.status !== 'ready'
        ? <Message tone="caution" size="line" live className="px-3 py-2" title={skillsUnverified(t, catalog)} />
        : <Message tone="empty" size="line" live icon="search" className="px-3 py-2" title={t('input.noMatches')} />)}
      {/* The projects lead the list as one row of their labels, scrolled sideways, its far end faded when more follow. */}
      {menu.items.some(item => item.project) && <div role="group" aria-label={t('input.projects')} data-project-row
        className="flex gap-1.5 overflow-x-auto border-b border-line px-3 pt-0.5 pb-2 [scrollbar-width:none] [mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)]">
        {menu.items.map((item, index) => item.project && <button key={item.id} type="button" role="option" aria-selected={index === menu.index} title={item.id} onClick={() => menu.pick(item)}
          className={cn('inline-flex flex-none items-center gap-1.5 rounded-sm border border-line px-2 py-1 pointer-coarse:min-h-10', index === menu.index && 'border-muted bg-hover')}>{item.label}</button>)}
        <span aria-hidden="true" className="w-6 flex-none" />
      </div>}
      {menu.items.map((item, index) => !item.project && <button key={item.id} type="button" role="option" aria-selected={index === menu.index} onClick={() => menu.pick(item)} className={cn('flex w-full items-center gap-2 px-3 py-1.5 text-left pointer-coarse:min-h-11', index === menu.index && 'bg-hover')}>{item.label}{menu.kind === 'task' && item.id === viewing && <span data-viewing className="flex-none text-xs text-muted">{t('input.viewing')}</span>}</button>)}
    </div>, at.body)}
  </div>;
}
export function typeTrigger(editor: Editor | null, char: '#' | '/') {
  if (!editor || !editor.isEditable) return;
  const before = editor.state.doc.textBetween(Math.max(0, editor.state.selection.from - 1), editor.state.selection.from, '\n', '\ufffc');
  editor.chain().focus().insertContent(`${INSIDE_WORD.test(before) ? ' ' : ''}${char}`).run();
}
