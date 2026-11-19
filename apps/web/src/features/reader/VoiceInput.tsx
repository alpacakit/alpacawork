/* The editor adapter for the voice capture lifecycle. captureVoice and voiceStream own audio and recognition. */
import { countUse } from '@/features/telemetry/count';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Editor } from '@tiptap/react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { useSurfaceDocument } from '@/lib/surface';
import { isComposingKey } from '@/components/ui/composing';
import { captureVoice, type VoiceState } from './voice-capture';
import type { VoiceFailure, VoiceFailureKind } from './voice-stream';
import { notify, recordFailure } from '@/lib/notify';
import { ApiError } from '@/data/client';
import { i18n } from '@alpacawork/i18n';
export const VOICE_TRANSACTION = 'coordinator-voice-text';

/** One recording freezes a selection. Incremental finals replace that selection once, then append at its cursor. */
export function useVoiceInput(field: RefObject<Editor | null>, disabled: boolean, lock: (active: boolean) => void) {
  const current = useRef({ disabled, lock }); current.current = { disabled, lock };
  const session = useRef<ReturnType<typeof captureVoice> | null>(null);
  const [state, setState] = useState<VoiceState>('idle');
  const [partial, setPartial] = useState('');
  const [seconds, setSeconds] = useState(0);
  const cursor = useRef(0), end = useRef(0), inserted = useRef(0);
  const placement = useRef<{ editor: Editor; chosen: boolean } | null>(null);
  useEffect(() => {
    const editor = field.current;
    if (!editor || editor.isDestroyed) return;
    if (placement.current?.editor !== editor) placement.current = { editor, chosen: false };
    const choose = () => { placement.current!.chosen = true; };
    // Initial content and context replacement also move the selection. Only interacting with the editor (including
    // entering it by keyboard) chooses a voice insertion point; an untouched input appends after its context labels.
    editor.on('focus', choose);
    const dom = editor.view.dom;
    for (const event of ['pointerdown', 'keydown', 'beforeinput']) dom.addEventListener(event, choose);
    return () => {
      editor.off('focus', choose);
      for (const event of ['pointerdown', 'keydown', 'beforeinput']) dom.removeEventListener(event, choose);
    };
  });
  const active = state === 'connecting' || state === 'recording' || state === 'finalizing';
  const enabled = !!document.querySelector('meta[name="alpacawork-voice"]');
  const release = (next: 'idle' | 'failed' = 'idle') => { session.current = null; current.current.lock(false); setPartial(''); setState(next); };
  const cancel = () => { session.current?.cancel(); release(); };
  useEffect(() => () => { session.current?.cancel(); current.current.lock(false); }, []);
  useEffect(() => { if (disabled) cancel(); }, [disabled]);
  useEffect(() => {
    if (state !== 'recording') return;
    const timer = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);
  const stop = () => session.current?.stop();
  const toggle = () => {
    if (!enabled || current.current.disabled) return;
    if (session.current) { stop(); return; }
    const editor = field.current;
    if (!editor || editor.isDestroyed) return;
    const { from, to } = editor.state.selection;
    const chosen = placement.current?.editor === editor && placement.current.chosen;
    cursor.current = chosen ? from : editor.state.doc.content.size - 1; end.current = chosen ? to : cursor.current; inserted.current = 0;
    notify.dismiss('voice-input'); setPartial(''); setSeconds(0); current.current.lock(true);
    countUse('voice');
    session.current = captureVoice({
      state: setState, partial: setPartial,
      final(text) {
        if (current.current.disabled || editor.isDestroyed) return;
        const next = text.slice(inserted.current); if (!next) return;
        const tr = editor.state.tr.insertText(next, cursor.current, end.current).setMeta(VOICE_TRANSACTION, true);
        editor.view.dispatch(tr);
        cursor.current += next.length; end.current = cursor.current; inserted.current = text.length;
      },
      ended() { release(); requestAnimationFrame(() => { if (!editor.isDestroyed) editor.chain().focus().setTextSelection(cursor.current).run(); }); },
      failed(failure) { release('failed'); sayVoiceFailure(failure, at, () => latest.current()); },
    });
  };
  const at = useSurfaceDocument();
  const latest = useRef(toggle); latest.current = toggle;
  useEffect(() => {
    if (!enabled || disabled) return;
    const key = (event: KeyboardEvent) => {
      if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'm' && !isComposingKey(event)) {
        event.preventDefault(); latest.current();
      }
    };
    at.addEventListener('keydown', key); return () => at.removeEventListener('keydown', key);
  }, [at, enabled, disabled]);
  return { enabled, active, state, partial, seconds, at: cursor.current, toggle, stop, cancel };
}

/**
 * A recording that ended without its words, said once as a toast in the window it was made in: the kind in the
 * person's words, serve's own reason under it where it gave one (a missing key names what to set), and Try again where
 * pressing again can help. The cause is recorded once (recordFailure). Nothing is left over the input.
 */
const SAID: Record<VoiceFailureKind, () => string> = {
  permission: () => i18n.t('reader:voiceInput.failure.permission'), unsupported: () => i18n.t('reader:voiceInput.failure.unsupported'),
  unreachable: () => i18n.t('reader:voiceInput.failure.unreachable'), refused: () => i18n.t('reader:voiceInput.failure.refused'),
  lost: () => i18n.t('reader:voiceInput.failure.lost'), noSpeech: () => i18n.t('reader:voiceInput.failure.noSpeech'),
  tooLarge: () => i18n.t('reader:voiceInput.failure.tooLarge'), audio: () => i18n.t('reader:voiceInput.failure.audio'),
};
function sayVoiceFailure(failure: VoiceFailure, at: Document, again: () => void) {
  const heard = failure.kind === 'noSpeech';
  recordFailure(failure, `voice input: ${failure.kind}`);
  const restore = failure.cause instanceof ApiError && failure.cause.code === 'restore_changed' ? failure.cause : null;
  const text = restore ? restore.displayMessage : SAID[failure.kind]();
  const options = { id: 'voice-input', from: at, detail: restore ? undefined : failure.said,
    action: failure.kind === 'unreachable' || failure.kind === 'lost' || failure.kind === 'audio' || heard ? { label: i18n.t('reader:voiceInput.again'), run: again } : undefined };
  if (heard) notify.info(text, options); else notify.error(text, options);
}

/** The same microphone control serves the empty round action and the small tool when words are present. */
export function VoiceInput({ voice, disabled, round = false, className }: { voice: ReturnType<typeof useVoiceInput>; disabled: boolean; round?: boolean; className?: string }) {
  const { t } = useTranslation('reader');
  if (!voice.enabled) return null;
  return <Button type="button" variant={round ? 'default' : 'quiet'} disabled={disabled || voice.state === 'finalizing'}
    aria-label={t('voiceInput.start')} title={t('voiceInput.hint')} data-voice-state={voice.state} onClick={voice.toggle}
    className={cn(round ? 'size-8 flex-none rounded-full p-0 pointer-coarse:size-10' : 'size-8 flex-none rounded-full p-0 text-muted pointer-coarse:size-10', className)}><Icon name="microphone" className="size-4" /></Button>;
}
