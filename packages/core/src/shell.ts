/** One literal argument in a POSIX shell command. */
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
