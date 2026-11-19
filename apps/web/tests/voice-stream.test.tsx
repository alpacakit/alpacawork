import { beforeEach } from 'vitest';
import { allowFixtureWrites } from './read-fixtures';
beforeEach(allowFixtureWrites);
import { problemReasonText } from '../src/data/client';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { i18n, startI18n } from '@alpacawork/i18n';
import { VoiceFailure, voiceStream } from '../src/features/reader/voice-stream';

beforeAll(() => startI18n());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function socket() {
  class Socket {
    static instance: Socket;
    static OPEN = 1;
    readyState = 1;
    onmessage?: (event: { data: string }) => void;
    onopen?: () => void;
    onerror?: () => void;
    onclose?: (event: { code: number }) => void;
    opened?: () => void;
    close = vi.fn();
    send = vi.fn();
    constructor() { Socket.instance = this; }
    addEventListener(event: string, listener: () => void) { if (event === 'open') this.opened = listener; }
  }
  vi.stubGlobal('WebSocket', Socket);
  return Socket;
}

for (const provider of ['soniox', 'deepgram'] as const) test(`${provider} keeps its exact diagnostic and closes the connection`, async () => {
  const Socket = socket();
  const failed = vi.fn();
  const connection = voiceStream({ provider, token: 'fake', endpoint: 'wss://localhost/voice', model: 'fake', language_hints: [], terms: [] },
    { partial: vi.fn(), final: vi.fn(), ended: vi.fn(), failed });
  Socket.instance.opened?.(); await connection.ready;
  const diagnostic = 'The configured model is unavailable';
  Socket.instance.onmessage?.({ data: JSON.stringify(provider === 'soniox'
    ? { error_code: 403, error_message: diagnostic }
    : { type: 'Error', code: 'MODEL_NOT_FOUND', description: diagnostic }) });
  expect(failed).toHaveBeenCalledOnce();
  expect(failed.mock.calls[0]?.[0]).toBeInstanceOf(VoiceFailure);
  expect(failed.mock.calls[0]?.[0]).toMatchObject({ kind: 'lost', said: problemReasonText({ kind: 'voice_stream_failed', provider,
    code: provider === 'soniox' ? '403' : 'MODEL_NOT_FOUND', diagnostic }) });
  expect(Socket.instance.close).toHaveBeenCalledOnce();
});

test('stream connection failures use Japanese catalog text and settle their timer', async () => {
  await i18n.changeLanguage('ja');
  vi.useFakeTimers();
  const Socket = socket();
  const failed = vi.fn();
  const connection = voiceStream({ provider: 'soniox', token: 'fake', endpoint: 'wss://localhost/voice', model: 'fake', language_hints: [], terms: [] },
    { partial: vi.fn(), final: vi.fn(), ended: vi.fn(), failed });
  const rejected = expect(connection.ready).rejects.toMatchObject({ kind: 'unreachable' });
  await vi.advanceTimersByTimeAsync(8000); await rejected;
  expect(failed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unreachable' }));
  expect(Socket.instance.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test('local provider socket keeps receiving chunks across serve reconnect; provider failure still ends once', async () => {
  const { useConnection } = await import('../src/data/connection');
  const Socket = socket(), failed = vi.fn();
  const stream = voiceStream({ provider: 'deepgram', token: 'fake', endpoint: 'ws://127.0.0.1/voice', model: 'fake', language_hints: [], terms: [] },
    { partial: vi.fn(), final: vi.fn(), ended: vi.fn(), failed });
  Socket.instance.opened?.(); await stream.ready;
  useConnection.setState({ state: 'reconnecting', offline: true, fresh: false });
  const bytes = new ArrayBuffer(8); stream.audio(bytes);
  expect(Socket.instance.send).toHaveBeenCalledWith(bytes); expect(failed).not.toHaveBeenCalled();
  Socket.instance.onerror?.(); expect(failed).toHaveBeenCalledOnce();
  expect(Socket.instance.close).toHaveBeenCalledOnce(); stream.close();
});
