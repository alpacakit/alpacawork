/** Which launcher opens the screen on each host, and when the URL is printed instead. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserLauncher, openBrowser } from '../packages/cli-kit/src/browser.ts';

test('each host gets its own launcher; a Linux without a desktop gets none', () => {
  assert.equal(browserLauncher({}, 'darwin')?.command, 'open');
  assert.equal(browserLauncher({ DISPLAY: ':0' }, 'linux')?.command, 'xdg-open');
  assert.equal(browserLauncher({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')?.command, 'xdg-open');
  assert.deepEqual(browserLauncher({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux'), { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler'] });
  assert.equal(browserLauncher({}, 'linux'), null);
  assert.equal(browserLauncher({}, 'win32'), null);
});

test('over SSH or when the launcher fails, no browser is reported as opened', async () => {
  const url = 'http://127.0.0.1:5499/';
  let launched: string[] = [];
  const launch = async (command: string, args: string[]) => { launched = [command, ...args]; };
  assert.equal(await openBrowser(url, { DISPLAY: ':0', SSH_CONNECTION: '1 2 3 4' }, { platform: 'linux', launch }), 'remote');
  assert.deepEqual(launched, []);
  assert.equal(await openBrowser(url, { WSL_INTEROP: '/run/WSL/1_interop' }, { platform: 'linux', launch }), 'opened');
  assert.deepEqual(launched, ['rundll32.exe', 'url.dll,FileProtocolHandler', url]);
  assert.equal(await openBrowser(url, { DISPLAY: ':0' }, { platform: 'linux', launch: async () => { throw new Error('exit 3'); } }), 'no-browser');
});
