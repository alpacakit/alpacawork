export const firstReportLine = (text: string) => {
  for (const [line] of text.matchAll(/[^\n]+/g)) {
    const label = line.replace(/^[-*>#\s]+|\*\*|`/g, '').trim();
    if (label) return label;
  }
  return '';
};

/**
 * A member's reply as the one line its closed result says: the first line that says something. A link is its words,
 * and a line that only names its part ("Title", "題") says nothing, nor does that name before its words.
 */
export const resultLine = (text: string) => {
  for (const [line] of text.matchAll(/[^\n]+/g)) {
    const words = firstReportLine(line.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1'))
      .replace(/^(?:題|説明|title|description)(?:\s*[:：]\s*|\s*$)/i, '').trim();
    if (words) return words;
  }
  return '';
};
