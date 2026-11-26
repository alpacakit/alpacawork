/**
 * A plain `cd <dir> &&` or `cd <dir>;` at a command's start says where it ran, not what it does, so a step's one line
 * leaves it off. Only a bare directory word counts: quoted, escaped, expanded or with any other shell syntax, the command
 * is left as written, so the line never says something the command does not. Opened, the step shows all of it.
 */
const PLAIN_CD = /^cd[ \t]+[\w.\/~+][\w.\/~+-]*[ \t]*(?:&&|;)[ \t]*(?=[^\s;&|])/;
export const commandLine = (text: string) => text.replace(PLAIN_CD, '');
