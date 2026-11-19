/** Small synthetic inputs for the standalone maintenance tools; no workspace data is read. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function legacySource(root: string): void {
  mkdirSync(join(root, '.alpacawork'), { recursive: true });
  for (const name of ['connection.json', 'push.json', 'runs.sqlite']) writeFileSync(join(root, '.alpacawork', name), name);
  for (const [id, title, body] of [
    ['T2', 'Small "quoted" title', 'Short body'],
    ['T9', '重い😀'.repeat(25), 'Heavy body\n'.repeat(40)],
  ]) {
    mkdirSync(join(root, id, 'files'), { recursive: true });
    writeFileSync(join(root, id, 'index.md'), `---\nid: ${id}\nparentId: null\ntitle: "${title}"\nstate: done\n---\n${body}\n`);
    writeFileSync(join(root, id, 'files', 'note.txt'), `File for ${id}\n`);
  }
}

export function phoneResults(root: string): void {
  const window = (name: string, elapsedMs: number, frameMaxMs: number, extra = {}) => ({ name, elapsedMs, frameMaxMs,
    hostLoad: [1, 2, 3], completion: 'settled', scriptMs: null, ...extra });
  const files = {
    detail: [window('warm-detail-1', 99, 10), window('detail-open-1', 100, 20),
      window('detail-open-2', 101, 21), window('input-fold-1', 2.5, 2.5)],
    chat: [window('detail-open-3', 11000, 400), window('input-close-1', 3.5, 3.5), window('custom-1', 0.5, 0.5)],
    'messages-small': [window('detail-open-4', 102, 22), window('conversation-send-1', 5.5, 5.5, { scriptMs: 1.5 })],
    questions: [window('question-choice-1', 999, 99)],
  };
  for (const [directory, results] of Object.entries(files)) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, 'results.json'), JSON.stringify({ width: 390, height: 900, throttle: 4,
      profile: false, browser: 'synthetic-browser', results }));
  }
}
