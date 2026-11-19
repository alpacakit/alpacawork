import type { OptionPart } from '@alpacawork/contract/launch-options';

/** AST literals need quoting in a preview too: otherwise one argument containing spaces,
 * or literal brackets, would look like multiple arguments or an optional group.
 * Adjacent quoted fragments use the contract grammar, with no shell escaping.
 */
export function optionPartText(part: OptionPart): string {
  if (part.kind !== 'literal') return `{${part.name}}`;
  if (part.value !== '' && !/[\s[\]'"\u005d]/.test(part.value)) return part.value;
  return part.value.split("'").map(piece => `'${piece}'`).join(`"'"`);
}
