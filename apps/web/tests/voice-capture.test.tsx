import { beforeEach as beforeSendCase } from 'vitest';
import { allowFixtureWrites } from './read-fixtures';
beforeSendCase(allowFixtureWrites);
import { startI18n, i18n } from '@alpacawork/i18n';
beforeAll(() => startI18n());
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { captureVoice } from '../src/features/reader/voice-capture';
import { VoiceFailure } from '../src/features/reader/voice-stream';

afterEach(() => { vi.unstubAllGlobals(); });
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const events = () => ({ state: vi.fn(), partial: vi.fn(), final: vi.fn(), ended: vi.fn(), failed: vi.fn() });

function microphone(permission: Promise<unknown>) {
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => permission } });
  class Recorder {
    static instance: Recorder;
    state = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    static isTypeSupported(type: string) { return type === 'audio/webm'; }
    constructor() { Recorder.instance = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['recorded']) }); this.onstop?.(); }
  }
  vi.stubGlobal('MediaRecorder', Recorder);
  return Recorder;
}

test('cancelling before microphone permission stops the late stream without making a connection', async () => {
  let grant!: (stream: unknown) => void;
  microphone(new Promise(resolve => { grant = resolve; }));
  const stop = vi.fn(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const sink = events(); const recording = captureVoice(sink);
  await turn(); recording.cancel(); grant({ getTracks: () => [{ stop }] }); await turn();
  expect(stop).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
  expect(sink.failed).not.toHaveBeenCalled(); expect(sink.final).not.toHaveBeenCalled();
});

test('a token failure releases the microphone and translates the structured server code', async () => {
  await i18n.changeLanguage('ja');
  const stop = vi.fn(); microphone(Promise.resolve({ getTracks: () => [{ stop }] }));
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'voice_empty', retry: 'fix', message: 'Diagnostic text' } }, { status: 503 })));
  const sink = events(); captureVoice(sink); await turn(); await turn();
  expect(stop).toHaveBeenCalledOnce(); expect(sink.failed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'refused', said: '録音した音声がありません' }));
  expect(sink.final).not.toHaveBeenCalled();
});

test('cancelling recognition aborts the upload and discards even a late successful result', async () => {
  const stop = vi.fn(); microphone(Promise.resolve({ getTracks: () => [{ stop }] }));
  let complete!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/token')) return Response.json({ provider: 'local' });
    signal = init.signal as AbortSignal;
    return new Promise<Response>(resolve => { complete = resolve; });
  }));
  const sink = events(); const recording = captureVoice(sink); await turn(); await turn();
  expect(sink.state).toHaveBeenLastCalledWith('recording'); recording.stop(); await turn();
  expect(sink.state).toHaveBeenLastCalledWith('finalizing'); recording.cancel();
  expect(signal?.aborted).toBe(true); complete(Response.json({ text: 'stale transcript' })); await turn();
  expect(sink.final).not.toHaveBeenCalled(); expect(sink.failed).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalled();
});
