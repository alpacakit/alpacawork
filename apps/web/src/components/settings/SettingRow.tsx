import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { FieldError, FieldHint } from '@/components/ui/field';
import { cn } from '@/lib/utils';

/** The height a row of a settings list keeps, whatever its control; a fold's heading keeps it too. */
export const SETTING_ROW_SIZE = 'min-h-13 py-2 narrow:min-h-14';
/** A row of a settings list: a line over it and that one height. */
export const SETTING_ROW = `${SETTING_ROW_SIZE} border-t border-line`;

/**
 * One setting: its name, an optional hint, a status (saving…) or an error, and the control on the right, on the name's
 * line. On a phone the words under the name take the row's whole width, under the control too.
 */
export function SettingRow({ id, label, hint, status, error, className, children }: {
  id: string; label: string; hint?: string; status?: string; error?: string; className?: string; children: ReactNode;
}) {
  return <div data-slot="setting-row" className={cn(SETTING_ROW, 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 narrow:gap-x-4', className)}>
    <div className="min-w-0 narrow:contents">
      <Label id={`${id}-label`} htmlFor={id} className="font-normal narrow:min-w-0">{label}</Label>
      {/* Across every column the row has: a caller may give a phone's row one column. */}
      {(hint || status || error) && <div className="narrow:col-span-full narrow:row-start-2">
        {hint && <FieldHint className="mt-type-close">{hint}</FieldHint>}
        {status && <FieldHint role="status" className="mt-type-close">{status}</FieldHint>}
        {error && <FieldError className="mt-type-close">{error}</FieldError>}
      </div>}
    </div>
    {children}
  </div>;
}
