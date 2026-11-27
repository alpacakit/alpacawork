import { Problem, PROBLEM_CODE, redactSecrets } from '@alpacawork/core';

export const HTTP_BODY_BYTES = 64 * 1024;
export const HTTP_RESPONSE_BYTES = 4 * 1024;

export function parseDestination(value: string): URL {
  let url: URL;
  const invalid = () => new Problem(PROBLEM_CODE.invalidInput, 'Enter a valid HTTPS destination without credentials or a fragment',
    undefined, { reason: { kind: 'http_destination_invalid' } });
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname || url.hostname.length > 253)
    throw invalid();
  return url;
}

export function safeSigningKey(input: string | undefined): string {
  if (input === undefined) return '';
  const encoded = input.slice('whsec_'.length), key = Buffer.from(encoded, 'base64');
  if (!input.startsWith('whsec_') || key.length < 24 || key.length > 64 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, ''))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Enter a valid Standard Webhooks signing key');
  return key.toString('base64');
}

/** A remote response can echo the destination or part of it. Remove those before retaining the response. */
export function scrubHttpEvidence(value: string, destination: string, signingKey: string,
  { related = [], credentials = [], redactUrls = true }: { related?: string[]; credentials?: string[]; redactUrls?: boolean } = {}): string {
  const forms = new Set([signingKey, signingKey && `whsec_${signingKey}`, ...credentials].filter(Boolean));
  const decoded = (part: string) => {
    try { return decodeURIComponent(part); } catch { return part; }
  };
  for (const address of [destination, ...related]) {
    forms.add(address);
    forms.add(decoded(address));
  }
  const url = new URL(destination);
  const queryValues = url.search.slice(1).split('&').flatMap(parameter => {
    const equals = parameter.indexOf('=');
    return equals < 0 ? [] : [parameter.slice(equals + 1)];
  });
  // A short route or parameter value can be an ordinary field in the response.
  for (const part of [...url.pathname.split('/'), ...queryValues, ...url.searchParams.values()]) {
    const plain = decoded(part);
    if (plain.length < 12) continue;
    forms.add(part);
    forms.add(plain);
  }
  // Replace each observed spelling once so a shared fragment cannot modify the redaction marker.
  const spellings = new Set([...forms].flatMap(part => [part, JSON.stringify(part).slice(1, -1)]));
  const parts = [...spellings].sort((left, right) => right.length - left.length)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const withDestinationRemoved = value.replace(new RegExp(parts, 'gu'), '[destination]');
  if (!redactUrls) return withDestinationRemoved;
  return redactSecrets(withDestinationRemoved.replace(/https?:\/\/[^\s<>"']+/gi, '[URL]'));
}
