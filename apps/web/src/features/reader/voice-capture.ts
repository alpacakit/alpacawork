import { withRequestActivity } from '@/data/request-activity';
import { workspaceWriteBasis } from '@/data/connection';
import { mutationHeaders, requireWriteAccess } from '@/data/client';
import { apiError } from '@/data/client';
import { problemSchema } from '@alpacawork/contract/problem';
import { VoiceFailure, voiceStream, type VoiceEvents, type VoiceFailureKind, type VoiceTicket } from './voice-stream';

export type VoiceState = 'idle' | 'connecting' | 'recording' | 'finalizing' | 'failed';
type Events = VoiceEvents & { state(state: VoiceState): void };

/** Owns one recording, including late microphone permission and every terminal path. */
export function captureVoice(events: Events) {
  const basis=workspaceWriteBasis();
  const abort = new AbortController();
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let connection: ReturnType<typeof voiceStream> | undefined;
  let context: AudioContext | undefined;
  let processor: ScriptProcessorNode | undefined;
  let limit: ReturnType<typeof setTimeout> | undefined;
  let bytes = 0;
  let done = false;
  const cleanup = () => {
    clearTimeout(limit);
    abort.abort();
    connection?.close();
    processor?.disconnect(); processor = undefined;
    if (context && context.state !== 'closed') void context.close();
    if (recorder) {
      recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    stream?.getTracks().forEach(track => track.stop());
  };
  const finish = (failure?: VoiceFailure) => {
    if (done) return;
    done = true;
    cleanup();
    if (failure) events.failed(failure); else events.ended();
  };
  /** The one place a cause becomes a kind: what is said follows the kind, the cause stays with it for the console. */
  const failure = (cause: unknown, otherwise: VoiceFailureKind): VoiceFailure => {
    if (cause instanceof VoiceFailure) return cause;
    if (cause instanceof DOMException && (cause.name === 'NotAllowedError' || cause.name === 'SecurityError'))
      return new VoiceFailure('permission', cause.name, undefined, { cause });
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return new VoiceFailure('audio', cause.name, undefined, { cause });
    return new VoiceFailure(otherwise, cause instanceof Error ? cause.message : String(cause), undefined, { cause });
  };
  /** The server's refusal: its words name what to set (a missing key, a size), so they are said under the kind. */
  const refusal = async (response: Response, kind: VoiceFailureKind) => {
    const body: unknown = await response.json().catch(() => null);
    const problem = problemSchema.safeParse(body);
    const error = problem.success ? apiError(problem.data.error) : undefined;
    return new VoiceFailure(response.status === 413 ? 'tooLarge' : kind, `HTTP ${response.status}`, error?.displayMessage, { cause: error ?? body });
  };
  /** A request to serve with no answer (its own time limit, the network) is unreachable; a cancel stays a cancel. */
  const reach = (url: string, init: RequestInit, limit: number) => {
    requireWriteAccess(basis);
    const headers=mutationHeaders(basis,undefined,init.headers);
    return fetch(url, { ...init, headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(limit)]) })
      .catch((cause: unknown) => { throw abort.signal.aborted ? cause : new VoiceFailure('unreachable', url, undefined, { cause }); });
  };
  const cancel = () => { if (done) return; done = true; cleanup(); };
  const stop = () => {
    if (done) return;
    if ((!recorder || recorder.state !== 'recording') && !processor) { cancel(); events.ended(); return; }
    clearTimeout(limit);
    events.state('finalizing');
    if (recorder) recorder.stop();
    else { processor?.disconnect(); processor = undefined; connection?.stop(); }
    stream?.getTracks().forEach(track => track.stop());
  };
  const recordingStarted = () => {
    events.state('recording');
    limit = setTimeout(stop, 60_000);
  };
  events.state('connecting');
  void Promise.resolve().then(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        throw new VoiceFailure('unsupported', 'no getUserMedia');
      const mimeType = window.MediaRecorder && ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
        .find(type => MediaRecorder.isTypeSupported(type));
      // Safari's cloud path needs PCM: Soniox realtime does not accept MP4.
      // Resume here, before the first await, while this tap is still a user gesture.
      if ((!mimeType || mimeType === 'audio/mp4') && window.AudioContext) {
        context = new AudioContext();
        void context.resume().catch(() => {});
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (done) { stream.getTracks().forEach(track => track.stop()); return; }
      const ticket = await withRequestActivity(async () => {
        const response = await reach('/api/voice/token', { method: 'POST' }, 8000);
        if (!response.ok) throw await refusal(response, 'refused');
        return await response.json().catch(() => { throw new VoiceFailure('refused', 'unreadable token'); }) as VoiceTicket | { provider: 'local' };
      });
      if (done) return;
      const chunks: Blob[] = [];
      if (ticket.provider !== 'local') {
        connection = voiceStream(ticket, {
          partial: text => { if (!done) events.partial(text); },
          final: text => { if (!done) events.final(text); },
          ended: () => finish(), failed: cause => finish(cause),
        }, context?.sampleRate);
        await connection.ready;
        if (done) return;
      }
      if (ticket.provider !== 'local' && context) {
        if (context.state !== 'running') throw new VoiceFailure('audio', `AudioContext ${context.state}`);
        const source = context.createMediaStreamSource(stream);
        processor = context.createScriptProcessor(2048, 1, 1);
        const silent = context.createGain(); silent.gain.value = 0;
        processor.onaudioprocess = event => {
          if (done) return;
          const samples = event.inputBuffer.getChannelData(0);
          const pcm = new Int16Array(samples.length);
          for (let index = 0; index < samples.length; index++) {
            const sample = Math.max(-1, Math.min(1, samples[index]!));
            pcm[index] = sample < 0 ? sample * 32768 : sample * 32767;
          }
          connection?.audio(pcm.buffer);
        };
        source.connect(processor); processor.connect(silent); silent.connect(context.destination);
        recordingStarted();
        return;
      }
      if (!mimeType) throw new VoiceFailure('unsupported', 'no recording format');
      if (context && context.state !== 'closed') { void context.close(); context = undefined; }
      recorder = new MediaRecorder(stream, { mimeType });
      recorder.onerror = () => finish(new VoiceFailure('audio', 'MediaRecorder error'));
      recorder.ondataavailable = event => {
        if (done || !event.data.size) return;
        bytes += event.data.size;
        if (bytes > 15 * 1024 * 1024) { finish(new VoiceFailure('tooLarge', `${bytes} bytes`)); return; }
        if (connection) connection.audio(event.data); else chunks.push(event.data);
      };
      recorder.onstop = () => {
        if (done) return;
        if (connection) { connection.stop(); return; }
        void (async () => {
          try {
            const form = new FormData();
            form.set('file', new Blob(chunks, { type: mimeType }), mimeType.includes('mp4') ? 'recording.m4a' : 'recording.webm');
            const result = await withRequestActivity(async () => {
              const response = await reach('/api/voice/transcriptions', { method: 'POST', body: form }, 185_000);
              if (!response.ok) throw await refusal(response, 'lost');
              return await response.json() as { text?: unknown };
            });
            if (typeof result.text !== 'string') throw new VoiceFailure('lost', 'unreadable transcription');
            if (done) return;
            if (!result.text.trim()) throw new VoiceFailure('noSpeech', 'empty transcription');
            events.final(result.text);
            finish();
          } catch (cause) { if (!done) finish(failure(cause, 'lost')); }
        })();
      };
      recorder.start(250);
      recordingStarted();
    } catch (cause) {
      if (done) return;
      finish(failure(cause, 'audio'));
    }
  });
  return { stop, cancel };
}
