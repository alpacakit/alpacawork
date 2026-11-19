import { problemReasonText } from '@/data/client';
export type VoiceTicket = { provider: 'soniox' | 'deepgram'; token: string; endpoint: string; model: string;
  language_hints: string[]; terms: string[] };
/**
 * Why a recording ended without its words. The kind is what the person is told (reader:voiceInput.failure.*); the cause
 * (a provider's or the server's words, a DOMException) is kept for the console and, from the server, said under it.
 */
export type VoiceFailureKind = 'permission' | 'unsupported' | 'unreachable' | 'refused' | 'lost' | 'noSpeech' | 'tooLarge' | 'audio';
export class VoiceFailure extends Error {
  constructor(readonly kind: VoiceFailureKind, detail: string, readonly said?: string, options?: { cause?: unknown }) { super(detail, options); }
}
export type VoiceEvents = { partial(text: string): void; final(text: string): void; ended(): void; failed(failure: VoiceFailure): void };

/** Provider wire formats end here; the composer sees only partial, final, end, and failure. */
export function voiceStream(ticket: VoiceTicket, events: VoiceEvents, pcmSampleRate?: number) {
  const soniox = ticket.provider === 'soniox';
  const url = new URL(ticket.endpoint);
  if (!soniox) {
    url.searchParams.set('model', ticket.model);
    url.searchParams.set('language', ticket.language_hints[0] ?? 'ja');
    url.searchParams.set('interim_results', 'true');
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set('endpointing', '300');
    if (pcmSampleRate) { url.searchParams.set('encoding', 'linear16'); url.searchParams.set('sample_rate', String(pcmSampleRate)); }
    for (const term of ticket.terms) url.searchParams.append('keyterm', term);
  }
  const socket = new WebSocket(url, [soniox ? 'soniox-api-key' : 'bearer', ticket.token]);
  let final = '';
  let ending = false;
  let done = false;
  let opened = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectReady: (cause: Error) => void = () => {};
  const finish = () => { if (done) return; done = true; clearTimeout(timeout); events.ended(); socket.close(); };
  const fail = (kind: VoiceFailureKind, detail: string, said?: string) => {
    if (done) return; done = true; clearTimeout(timeout);
    const failure = new VoiceFailure(kind, detail, said); rejectReady(failure); events.failed(failure); socket.close();
  };
  const send = (data: string | Blob | ArrayBuffer) => {
    try { socket.send(data); }
    catch (cause) { fail('unreachable', cause instanceof Error ? cause.message : String(cause)); }
  };
  socket.onopen = () => {
    opened = true;
    if (soniox) send(JSON.stringify({ model: ticket.model, audio_format: pcmSampleRate ? 'pcm_s16le' : 'auto',
      ...(pcmSampleRate ? { sample_rate: pcmSampleRate, num_channels: 1 } : {}),
      language_hints: ticket.language_hints, context: { terms: ticket.terms }, enable_endpoint_detection: true }));
  };
  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(String(event.data));
      if (soniox) {
        if (data.error_code) { fail('lost', `${ticket.provider}: ${data.error_message ?? data.error_code}`, problemReasonText({ kind: 'voice_stream_failed', provider: ticket.provider, code: String(data.error_code), diagnostic: typeof data.error_message === 'string' ? data.error_message : undefined })); return; }
        let partial = '';
        for (const token of data.tokens ?? []) {
          if (token.text === '<end>' || token.text === '<fin>') continue;
          if (token.is_final) { final += token.text; events.final(final); }
          else partial += token.text;
        }
        events.partial(partial);
        if (data.finished) finish();
      } else {
        if (data.type === 'Error') { fail('lost', `${ticket.provider}: ${data.description ?? 'Error'}`, problemReasonText({ kind: 'voice_stream_failed', provider: ticket.provider, code: String(data.code ?? data.type), diagnostic: typeof data.description === 'string' ? data.description : undefined })); return; }
        if (data.type === 'Results') {
          const text = data.channel?.alternatives?.[0]?.transcript ?? '';
          if (data.is_final) {
            if (final && /[A-Za-z0-9.,!?;:]$/.test(final) && /^[A-Za-z0-9]/.test(text)) final += ' ';
            final += text; events.final(final); events.partial('');
          }
          else events.partial(text);
        }
      }
    } catch { fail('lost', 'unreadable recognition response'); }
  };
  socket.onerror = () => fail(opened ? 'lost' : 'unreachable', `${ticket.provider}: socket error`);
  socket.onclose = (event) => { if (!done) !soniox && ending && event.code === 1000 ? finish() : fail('lost', `${ticket.provider}: closed ${event.code}`); };
  return {
    ready: new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      timeout = setTimeout(() => fail('unreachable', `${ticket.provider}: no open in 8s`), 8000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    }),
    audio: (bytes: Blob | ArrayBuffer) => { if (socket.readyState === WebSocket.OPEN && (bytes instanceof Blob ? bytes.size : bytes.byteLength)) send(bytes); },
    stop: () => {
      if (done || ending || socket.readyState !== WebSocket.OPEN) return;
      ending = true;
      if (soniox) { send(JSON.stringify({ type: 'finalize' })); send(''); }
      else { send(JSON.stringify({ type: 'Finalize' })); send(JSON.stringify({ type: 'CloseStream' })); }
      timeout = setTimeout(() => fail('lost', `${ticket.provider}: no final in 8s`), 8000);
    },
    close: () => { done = true; clearTimeout(timeout); rejectReady(new Error('cancelled')); socket.close(); },
  };
}
