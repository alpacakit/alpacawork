/**
 * How many tokens, written one way across the whole app and in every language, as models and agents' own screens
 * write them: 950, 12k, 610k, 1.4M, 2.1B. The step is the largest the count reaches; a step past thousands keeps one
 * place.
 */
export const TOKEN_STEPS = [{ at: 1e9, unit: "B", digits: 1 }, { at: 1e6, unit: "M", digits: 1 }, { at: 1e3, unit: "k", digits: 0 }] as const;
export type TokenStep = (typeof TOKEN_STEPS)[number];

/** The step a count is written in, or null under a thousand. */
export const tokenStep = (tokens: number): TokenStep | null => TOKEN_STEPS.find(step => tokens >= step.at) ?? null;

const fixed = new Map<number, Intl.NumberFormat>();
/** A number to `digits` places, with the same marks in every language (1.4, never 1,4). */
export const tokenNumber = (value: number, digits: number) => {
  let format = fixed.get(digits);
  if (!format) fixed.set(digits, format = new Intl.NumberFormat("en", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }));
  return format.format(value);
};

/** A count as its number and its step's letter ("1.4", "M"); under a thousand, the whole count and no letter. */
export function tokenParts(tokens: number): { value: string; unit: string } {
  const step = tokenStep(tokens);
  return step ? { value: tokenNumber(tokens / step.at, step.digits), unit: step.unit } : { value: tokenNumber(tokens, 0), unit: "" };
}

/** A count as one word: "610k", "1.4M". */
export const tokenText = (tokens: number) => { const { value, unit } = tokenParts(tokens); return `${value}${unit}`; };
