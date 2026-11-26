/** The same canonical GitHub pull request link wherever a record or a tool result refers to one. */
export function prLinks(values: Iterable<string>): Set<string> {
  const result = new Set<string>();
  for (const text of values)
    for (const match of text.matchAll(/(?<![\w.@/-])https:\/\/github\.com\/([\w-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?![\w-])/gi))
      result.add(`https://github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}/pull/${match[3]}`);
  return result;
}
