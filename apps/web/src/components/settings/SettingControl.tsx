import type { SettingDefinition } from '@alpacawork/contract';
import { NativeSelect } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';

type ControlProps = { definition: SettingDefinition; id: string; value: string | boolean | null;
  disabled?: boolean; onChange: (value: string | boolean | null) => void; label: string;
  optionLabel: (key: string) => string };
const controls = {
  toggle: ({ id, value, disabled, onChange, label }: ControlProps) =>
    <Switch id={id} aria-label={label} checked={value === true} disabled={disabled} onCheckedChange={onChange} />,
  // A yes or no saved at once is a switch, whichever kind its definition names.
  checkbox: ({ id, value, disabled, onChange, label }: ControlProps) =>
    <Switch id={id} aria-label={label} checked={value === true} disabled={disabled} onCheckedChange={onChange} />,
  select: ({ definition, id, value, disabled, onChange, label, optionLabel }: ControlProps) =>
    <NativeSelect id={id} variant="field" className="w-44" aria-label={label}
      value={String(value)} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {(definition.kind === 'select' ? definition.options : []).map((option) =>
        <option key={option.value} value={option.value}>{option.labelKey ? optionLabel(option.labelKey) : option.value}</option>)}
    </NativeSelect>,
};
export function SettingControl(props: ControlProps) {
  if (props.definition.kind === 'timeZone' || props.definition.kind === 'instant' ||
    props.definition.kind === 'languageTag') return null;
  return controls[props.definition.kind](props);
}
