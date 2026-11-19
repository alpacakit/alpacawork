/** Shared value-flag parsing and errors; each wrapper owns its flag meanings. */
export function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} needs a value`);
  return value;
}

export function parseFlags(args: readonly string[], handlers: ReadonlyMap<string, (value: string) => void>): void {
  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;
    const handler = handlers.get(option);
    if (!handler) unknownOption(option);
    handler(requiredValue(args, ++index, option));
  }
}

export function unknownOption(option: string): never {
  throw new Error(`Unknown option: ${option}`);
}

export function withUsage<T>(usage: string, parse: () => T): T {
  try { return parse(); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\n${usage}`); }
}

export function httpUrl(value: URL | null): URL {
  if (!value || !['http:', 'https:'].includes(value.protocol)) throw new Error('--url needs an HTTP URL');
  return value;
}
