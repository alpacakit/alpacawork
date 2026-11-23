/** The raw HTTP listener and read thread accept only loopback and the configured public host. */
export function commandOrigin(request: Request, publicHost?: string | null): string {
  const host = request.headers.get('host') ?? new URL(request.url).host;
  return `${host === publicHost ? 'https' : 'http'}://${host}`;
}

const linkKeys = new Set(['folder', 'path', 'absolutePath', 'url']);
/** Build presentation links after persistence so immutable receipts also work at another accepted origin. */
export function commandLinks(value: unknown, origin: string): unknown {
  if (Array.isArray(value)) return value.map(item => commandLinks(item, origin));
  if (!value || typeof value !== 'object') return value;
  // Values are user data. A field named 'path' inside a value can contain any text.
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === 'values' ? item
      : linkKeys.has(key) && typeof item === 'string' && item.startsWith('/api/') ? new URL(item, origin).href
      : commandLinks(item, origin)]));
}
