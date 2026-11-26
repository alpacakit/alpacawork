/**
 * A plain `cd <dir> &&` or `cd <dir>;` at a command's start says where it ran, not what it does, so a step's one line
 * leaves it off, but only where what follows reads the same without it: a bare directory word, then a command name,
 * and no `||` anywhere after (whether `cd` worked can decide what runs). Anything else (a quoted or expanded directory,
 * a line that goes on to the next or is a comment, a group, a fallback) keeps the command's own start, so the line never
 * says something the command does not. Opened, the step shows all of it.
 */
const PLAIN_CD = /^cd[ \t]+[\w./~+][\w./~+-]*[ \t]*(?:&&|;)[ \t]*/;
const COMMAND_NAME = /^[\w./~]/;
export function commandLine(text: string): string {
  const cd = PLAIN_CD.exec(text);
  const rest = cd ? text.slice(cd[0].length) : '';
  return COMMAND_NAME.test(rest) && !rest.includes('||') ? rest : text;
}
