/** Finite HTTP fixtures must drain status-only responses before their server closes. */
export async function fetchBuffered(input: URL, init?: RequestInit): Promise<Response> {
  const response = await globalThis.fetch(input, init);
  const bytes = await response.arrayBuffer();
  // Return a readable copy so assertions can still inspect headers, JSON and byte ranges.
  return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}
