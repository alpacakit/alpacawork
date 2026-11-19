import { EventEmitter } from 'node:events';
import type { InstallationTerminal } from '@alpacawork/backend/test-dist/installation/confirmation.js';
export function installationTerminal(answer: string | null, tty = true, earlyEnter = false) {
  const input = Object.assign(new EventEmitter(), { isTTY: tty, raw: false,
    setRawMode(value: boolean) { this.raw = value; }, resume() {}, pause() {} });
  let shown = '';
  const output = Object.assign(new EventEmitter(), { isTTY: tty, write(value: string, callback?: (e?: Error) => void) {
    shown += value;
    if (earlyEnter && value.startsWith('\n')) input.emit('data', Buffer.from('\r'));
    setImmediate(() => { callback?.(); if ((value.includes('Enter to start') || value.includes('Enter で始める') || value.includes('Press Enter to install') || value.includes('Enter で導入します') || value.includes('Press Enter to change') || value.includes('Enter で変更します') || value.includes('[Y/n]'))) setImmediate(() => answer === null ? input.emit('end') : input.emit('data', Buffer.from(answer))); });
    return true;
  } });
  return { value: { input, output, env: { LANG: 'en' }, discardPendingInput() {} } as InstallationTerminal,
    input, shown: () => shown };
}
