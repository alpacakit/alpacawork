import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { checkServerIdentity, connect } from 'node:tls';
import { hasCode } from '@alpacawork/core';
import { HTTP_RESPONSE_BYTES, parseDestination } from './http-config.js';

const TIMEOUT_MS = 10_000;
const ipv4 = new BlockList(), ipv6 = new BlockList(), globalV6 = new BlockList();
const ipv4Private: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
];
for (const [address, prefix] of ipv4Private) ipv4.addSubnet(address, prefix);
globalV6.addSubnet('2000::', 3, 'ipv6');
const ipv6Special: [string, number][] = [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]];
for (const [address, prefix] of ipv6Special) ipv6.addSubnet(address, prefix, 'ipv6');

export function publicHttpAddress(address: string, family: number): boolean {
  return family === 4 ? !ipv4.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !ipv6.check(address, 'ipv6');
}

export type HttpOutcome =
  | { kind: 'response'; status: number; body: string | null; retryAfter?: number }
  | { kind: 'unreachable' | 'unknown' | 'invalid_destination' };
export type HttpRequestOptions = { method?: 'GET' | 'POST' | 'PUT' | 'PATCH'; responseBytes?: number; signal?: AbortSignal };
export type PreparedHttp = { send(body: string, headers: Record<string, string>, options?: HttpRequestOptions): Promise<HttpOutcome> };
export type PrepareHttp = (destination: string, signal?: AbortSignal) => Promise<PreparedHttp | HttpOutcome>;

function retrySeconds(value: string | undefined): number | undefined {
  if (!value) return;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

type PinnedHttp = { address: string; family: number };
type DestinationResolution = { pinned: PinnedHttp } | { kind: 'unreachable' | 'invalid_destination' };

const tlsHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');

/** Resolve every answer against the same policy before pinning one address for a TLS connection. */
async function resolveHttpDestination(url: URL, signal?: AbortSignal): Promise<DestinationResolution> {
  if (signal?.aborted) return { kind: 'unreachable' };
  const hostname = tlsHost(url);
  const literal = isIP(hostname);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const addresses = literal ? [{ address: hostname, family: literal }] : await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<null>(resolve => {
        abort = () => resolve(null);
        timer = setTimeout(abort, TIMEOUT_MS);
        signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
    if (!addresses?.length) return { kind: 'unreachable' };
    if (addresses.some(({ address, family }) => !publicHttpAddress(address, family)))
      return { kind: 'invalid_destination' };
    return { pinned: addresses[0]! };
  } catch { return { kind: 'unreachable' }; }
  finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

export type DestinationCheckFailure = 'http_destination_blocked' | 'http_destination_unreachable' | 'http_destination_certificate';
export type VerifyHttpDestination = (url: URL) => Promise<DestinationCheckFailure | null>;

/** Only connect and validate TLS. Saving a URL sends no HTTP request, path, body or signing key. */
export const verifyHttpDestination: VerifyHttpDestination = async url => {
  const resolution = await resolveHttpDestination(url);
  if ('kind' in resolution) return resolution.kind === 'invalid_destination' ? 'http_destination_blocked' : 'http_destination_unreachable';
  const hostname = tlsHost(url);
  return new Promise(resolve => {
    const socket = connect({
      host: resolution.pinned.address, port: Number(url.port || 443),
      servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true,
      checkServerIdentity: (_host, certificate) => checkServerIdentity(hostname, certificate),
    });
    const timer = setTimeout(() => finish('http_destination_unreachable'), TIMEOUT_MS);
    function finish(result: DestinationCheckFailure | null) {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }
    socket.once('secureConnect', () => finish(null));
    socket.once('error', () => finish(
      socket.authorizationError ? 'http_destination_certificate' : 'http_destination_unreachable'));
  });
};

/** The chosen public address is pinned for the HTTPS request. Redirects are never followed. */
export const prepareHttp: PrepareHttp = async (destination, signal) => {
  const url = parseDestination(destination);
  const resolution = await resolveHttpDestination(url, signal);
  if ('kind' in resolution) return resolution;
  return { send: (body, headers, options) => sendHttp(url, resolution.pinned, body, headers, options) };
};

function sendHttp(url: URL, pinned: { address: string; family: number }, body: string,
  headers: Record<string, string>, { method = 'POST', responseBytes = HTTP_RESPONSE_BYTES, signal }: HttpRequestOptions = {}): Promise<HttpOutcome> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve({ kind: 'unreachable' }); return; }
    let timer: ReturnType<typeof setTimeout>;
    let connected = false;
    let headersReceived: (() => void) | undefined;
    const complete = (result: HttpOutcome) => { clearTimeout(timer); resolve(result); };
    const req = request(url, { method, agent: false, family: pinned.family, signal,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
      headers: { ...headers, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }) },
    }, response => {
      const status = response.statusCode;
      if (!status) { complete({ kind: 'unknown' }); response.destroy(); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      const responseResult = (body: string | null) => complete({ kind: 'response', status, body,
        retryAfter: retrySeconds(response.headers['retry-after']) });
      const interrupted = () => responseResult(null);
      headersReceived = interrupted;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        // Only retain complete bodies, so a truncated private URL cannot be exposed as a partial match.
        if (size >= responseBytes) { interrupted(); response.destroy(); }
        else chunks.push(chunk);
      });
      response.once('end', () => responseResult(size ? Buffer.concat(chunks).toString('utf8') : null));
      response.once('error', interrupted);
    });
    req.once('socket', socket => socket.once('connect', () => { connected = true; }));
    req.once('error', error => {
      if (headersReceived) { headersReceived(); return; }
      const notConnected = !connected && ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL'].some(code => hasCode(error, code));
      complete({ kind: notConnected ? 'unreachable' : 'unknown' });
    });
    timer = setTimeout(() => {
      if (headersReceived) headersReceived();
      else complete({ kind: 'unknown' });
      req.destroy();
    }, TIMEOUT_MS);
    req.end(method === 'GET' ? undefined : body);
  });
}
