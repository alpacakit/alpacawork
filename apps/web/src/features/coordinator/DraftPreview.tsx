import { ReplyLabelText } from './ReplyLabel';
import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/icon';
import { TaskIcon } from '@/components/ui/state-label';
import { useEveryTaskIndex } from '@/data/queries';
import { cn } from '@/lib/utils';
import type { Document, Inline } from './editor/document';
import { LabelFace, SkillMark, TaskLabelText, AnswerLabelText, ProjectLabelText, projectFace } from './LabelFace';
import { useProjectMarks } from '@/data/project-marks';

type Label = Exclude<Inline, { type: 'text' | 'hardBreak' }>;
/** A visual projection only: recipients, choices and skills precede the person's words. */
export function previewContent(doc: Document) {
  const labels: Label[] = [];
  const text = doc.content.map(block => (block.content ?? []).map(node => {
    if (node.type === 'text') return node.text;
    if (node.type === 'hardBreak') return ' ';
    labels.push(node);
    return '';
  }).join('')).join(' ').replace(/\s+/g, ' ').trim();
  const order = { replyLabel: -1, taskLabel: 0, answerLabel: 1, skillLabel: 2 };
  return { labels: labels.sort((a, b) => order[a.type] - order[b.type]), text };
}
/** Titles can give up their width; whole labels that cannot fit are counted at the end. */
export function fittingLabels(width: number, minimums: number[], counter: number, gap: number) {
  let used = 0;
  for (let count = 0; count < minimums.length; count++) {
    const next = used + (count ? gap : 0) + minimums[count]!;
    const remaining = count + 1 < minimums.length;
    if (next + (remaining ? gap + counter : 0) > width) return count;
    used = next;
  }
  return minimums.length;
}

/** The preview is inside the capsule's open button, so none of its label faces contains controls or takes focus. */
export function DraftPreview({ doc, preview }: { doc: Document; preview: { readonly labels: readonly Label[]; readonly text: string } }) {
  const { labels, text } = preview;
  const index = useEveryTaskIndex();
  const marks = useProjectMarks();
  const area = useRef<HTMLSpanElement>(null), ruler = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<{ count: number; minimums: number[] }>({ count: labels.length, minimums: [] });
  const face = (label: Label) => {
    if (label.type === 'replyLabel') return <LabelFace kind="reply"><ReplyLabelText answeredAt={label.attrs.answeredAt} /></LabelFace>;
    if (label.type === 'taskLabel') {
      const mark = marks.get(label.attrs.id);
      if (mark) return <LabelFace kind="project" style={projectFace(mark)}><ProjectLabelText mark={mark} /></LabelFace>;
      const task = index.byId.get(label.attrs.id);
      return <LabelFace kind="task"><TaskLabelText id={label.attrs.id} title={task?.title ?? label.attrs.title}
        mark={task && <TaskIcon task={task} className="size-3 flex-none" />} /></LabelFace>;
    }
    // No × follows it here, so its right side takes the left's room.
    if (label.type === 'answerLabel') return <LabelFace kind="answer" className="pr-2"><AnswerLabelText n={label.attrs.n} name={label.attrs.name} /></LabelFace>;
    return <LabelFace kind="skill"><SkillMark />{label.attrs.name}</LabelFace>;
  };
  const faces = labels.map(face);
  useLayoutEffect(() => {
    const root = area.current, measure = ruler.current;
    if (!root || !measure) return;
    const place = () => {
      const samples = [...measure.querySelectorAll<HTMLElement>('[data-preview-measure]')];
      const minimums = samples.map(sample => sample.getBoundingClientRect().width - (sample.querySelector('[data-label-title]')?.getBoundingClientRect().width ?? 0));
      const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 0;
      const counter = measure.querySelector('[data-preview-counter]')!.getBoundingClientRect().width;
      const count = fittingLabels(root.getBoundingClientRect().width - (text ? gap : 0), minimums, counter, gap);
      setFit(was => was.count === count && was.minimums.length === minimums.length && was.minimums.every((n, i) => n === minimums[i]) ? was : { count, minimums });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root); observer.observe(measure);
    return () => observer.disconnect();
  }, [doc, index]);
  const count = Math.min(fit.count, labels.length);
  return <span ref={area} data-capsule-draft aria-hidden="true" className="relative flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
    {labels.slice(0, count).map((label, i) => <span key={i} data-capsule-label={label.type} className={cn('flex', label.type === 'taskLabel' ? 'min-w-0 shrink' : 'flex-none')}
      style={label.type === 'taskLabel' ? { minWidth: fit.minimums[i] } : undefined}>{faces[i]}</span>)}
    {count < labels.length && <span data-capsule-more className="flex-none text-sm text-muted">+{labels.length - count}</span>}
    {text && <span data-capsule-text className="min-w-0 flex-1 truncate text-ink">{text}</span>}
    {/* Natural faces supply their own metrics, including the shared typography; never estimate from string length. */}
    <span ref={ruler} className="pointer-events-none invisible absolute top-0 left-0 flex w-max items-center gap-0.5">
      {faces.map((face, i) => <span key={i} data-preview-measure className="flex flex-none">{face}</span>)}
      <span data-preview-counter className="flex-none text-sm">+{labels.length}</span>
    </span>
  </span>;
}
