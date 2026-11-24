# Local voice trial

The current composer's microphone writes into its existing draft at the selected range. Recording and transcription block sending; sending is a separate action. `Alt+Shift+M` starts/stops recording. Navigation or disabling the input cancels its microphone, connection and late result. Each recording ends after 60 seconds. MediaRecorder supports WebM/Opus, Ogg/Opus and MP4; the retained cloud streaming adapters use PCM on MP4-only Safari.

## Application configuration

Omit the `voice` section to keep ordinary inputs unchanged: no microphone, voice wrapper or shortcut is enabled, and both voice API paths answer through the application's ordinary not-found response. No model service is needed for such a workspace.

Set `config.yaml` in the workspace where you want to try voice input, then reload the page:

```yaml
voice:
  provider: local
  endpoint: http://127.0.0.1:29473/v1/audio/transcriptions
  model: Qwen/Qwen3-ASR-1.7B
  language: ja
```

The backend owns destination/model/language and proxies multipart audio to loopback only. Redirects are refused. The browser sees only `provider: local` and sends audio to its own application origin. Neither service saves recordings. Local recognition is **batch after stopping**, without live subtitles. The endpoint accepts 16 MiB uploads, one recognition at a time, and returns `{text}`. A second concurrent recognition fails with 429, surfaced as a retryable error in the input. ffmpeg is restricted to pipe input protocols.

`node scripts/voice/recognizer.ts --binary <qwen_asr> --model <model-directory> --port 29473` starts the loopback recognizer for the example above. It requires Node 24, ffmpeg and the CPU binary from [antirez/qwen-asr](https://github.com/antirez/qwen-asr), linked with OpenBLAS, plus official [Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) weights. It uses 8 CPU threads; it does not use the GPU or download weights during recognition.

## Selection and limits

Qwen3-ASR-1.7B is an accuracy-focused trial candidate, not a demonstrated winner for every Japanese recording. Its official multilingual evaluation includes Japanese but reports averages. [Kotoba's Japanese CER table](https://huggingface.co/kotoba-tech/kotoba-whisper-v2.0) shows Kotoba v2 winning on ReazonSpeech and Whisper large-v3 on CV8/JSUT. [Parakeet-ja](https://huggingface.co/nvidia/parakeet-tdt_ctc-0.6b-ja) is another strong Japanese candidate. Different normalization and datasets prevent a universal ranking.

This trial uses unchanged BF16 Qwen weights via a separate C runtime. Official Qwen GPU/vLLM speed numbers do not describe it. Physical phone/browser permission behavior and the user's own speech remain to be tried; a narrow Chromium viewport is not a physical iPhone test.
