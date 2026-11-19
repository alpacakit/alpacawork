import type { ReactNode } from 'react';
import { FieldHint } from '@/components/ui/field';
import { cn } from '@/lib/utils';

/**
 * A group of settings under its heading. The heading leads its rows by weight, not size (the home list's rule: a
 * group's 600 heading over 400 rows); `sub` is a group inside a folded part, a step smaller. Its rows part by lines
 * (SettingRow), so nothing here sets the room between them; a group of other parts (`spaced`: a field, its count, a
 * list) keeps the room fields keep.
 */
export function SettingSection({ id, title, note, sub = false, spaced = false, children }: {
  id: string; title: string; note?: string; sub?: boolean; spaced?: boolean; children: ReactNode;
}) {
  return <section aria-labelledby={id} className="mb-8 last:mb-0">
    <h2 id={id} tabIndex={-1} className={cn("outline-none", sub ? "text-sm font-semibold" : "text-base font-semibold")}>{title}</h2>
    {note && <FieldHint className="mt-type-close">{note}</FieldHint>}
    <div className={cn("flex flex-col", spaced ? "mt-3 gap-4" : "mt-2")}>{children}</div>
  </section>;
}
