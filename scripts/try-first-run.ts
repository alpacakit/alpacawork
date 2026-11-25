/** Linux-only first-run preview. Build with the caller's tool cache; run the distribution in a disposable HOME. */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { hostname } from 'node:os';

const repo = realpathSync(new URL('..', import.meta.url));
const script = resolve(import.meta.filename);
const { values } = parseArgs({ options: { port: { type: 'string' }, minutes: { type: 'string', default: '30' },
  lang: { type: 'string', default: 'ja' }, width: { type: 'string', default: '1440' }, yes: { type: 'boolean', short: 'y' }, detach: { type: 'boolean', short: 'd' }, 'no-open': { type: 'boolean' }, check: { type: 'boolean' }, stop: { type: 'string' }, watchdog: { type: 'string' }, help: { type: 'boolean' } } });
const japanese = values.lang === 'ja';
if (values.help) {
  console.log(japanese ? `使い方: node scripts/try-first-run.ts [--port <空きポート>] [--minutes 30] [--lang ja|en] [-y|--yes] [-d|--detach] [--no-open] [--check] [--width 390|1440]
このcheckoutをビルドし、/tmpで本物のsetupを実行します（既定の言語: ja）。一覧を確認してEnterで進みます。
-y / --yes は確認を省略します。--no-open はブラウザを開きません。
-d / --detach はsetupのあと端末を返し、期限までバックグラウンドで動かします。
別のPCでは、表示されたsshの転送コマンドを実行してから、表示されたURLを開けます。
Codexはサインイン済みの代役、Claude Codeは未サインインです。使用統計は選べますが、外部送信は遮断します。
同梱スキルは本物です。配布元から入れるスキルは、通信せず、試用と明記したダミーファイルを置きます。
AIのコマンドはすべて代役で、結果は決まった内容です。通知は届きません。
本番のHOME・データ・資格情報・サービス・5499番ポートは使いません。
期限またはCtrl-Cで終了し、一時ファイルを削除します。
--check は、PTYでEnterを送るsetupと、非TTYで--yesを付けるsetup、4つのステップから例の結果の完了までを自動確認して終了します。
スマホ幅は --check --width 390 で確かめます（既定: 1440）。
途中で止める: node scripts/try-first-run.ts --stop <表示された一時フォルダ>` : `Usage: node scripts/try-first-run.ts [--port <free port>] [--minutes 30] [--lang ja|en] [-y|--yes] [-d|--detach] [--no-open] [--check] [--width 390|1440]
Builds this checkout and runs its real setup in /tmp (default language: ja). Review the plan and press Enter to continue.
-y / --yes skips confirmation. --no-open keeps the browser closed.
-d / --detach returns the terminal after setup and runs in the background until the deadline.
From another PC, run the printed SSH forwarding command there, then open the printed URL.
Codex is a stand-in that is signed in; Claude Code is signed out. Usage data can be chosen; sends out are intercepted locally.
Bundled skills are real; skills from their source install clearly marked local placeholder files, without contacting it.
Every agent command is a stand-in with scripted results. Notifications do not arrive.
No production HOME, data, credentials, service manager, or port 5499 is used.
The preview stops and deletes its temporary files at the deadline or on Ctrl-C.
--check runs setup with Enter in a PTY, then setup with --yes without a terminal, goes through the four steps to an
example's result and its completion, and exits. Use --check --width 390 for phone width (default 1440).
Stop early: node scripts/try-first-run.ts --stop <printed temporary directory>`);
  process.exit(0);
}
if (!['ja', 'en'].includes(values.lang!)) throw new Error('Choose --lang ja or --lang en.');
if (!['390', '1440'].includes(values.width!)) throw new Error('Choose --width 390 or --width 1440 for the automatic check.');
if (process.platform !== 'linux') throw new Error('This preview requires Linux.');
const identity = (pid: number) => {
  try { const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' '); return fields[0] === 'Z' ? null : fields[19]; }
  catch { return null; }
};
async function stopPreviewService(root: string, home: string) {
  const manager = join(root, 'bin/systemctl');
  if (!existsSync(manager)) return;
  const run = (mode: string) => new Promise<boolean>(done => {
    const stop = spawn(process.execPath, [manager, '--user', mode, 'alpacawork.service'], {
      env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config') }, stdio: 'ignore' });
    stop.once('error', () => done(false)); stop.once('close', code => done(code === 0));
  });
  if (!await run('stop') && !await run('kill')) throw new Error(`Preview service could not be stopped; preserve ${root} and rerun --stop.`);
}
function saved(root: string) {
  if (!/^\/tmp\/alpacawork-first-run-[A-Za-z0-9]+$/.test(root) || realpathSync(root) !== root) throw new Error('Refusing a non-preview directory.');
  const marker = JSON.parse(readFileSync(join(root, 'preview.json'), 'utf8'));
  if (marker.root !== root || marker.home !== join(root, 'home') || marker.port === 5499 || !Number.isInteger(marker.pid) || marker.pid <= 1 || typeof marker.start !== 'string')
    throw new Error('Invalid preview ownership record.');
  return marker;
}
if (values.stop || values.watchdog) {
  const root = values.stop ?? values.watchdog!;
  if (values.stop && /^\/tmp\/alpacawork-first-run-[A-Za-z0-9]+$/.test(root) && !existsSync(root)) {
    console.log(japanese ? '試用環境は停止・削除済みです。' : 'Preview already stopped and removed.'); process.exit(0);
  }
  const marker = saved(root);
  if (values.watchdog) await delay(Math.max(0, marker.expiresAt - Date.now()));
  if (identity(marker.pid) === marker.start) process.kill(marker.pid, 'SIGTERM');
  {
    for (let tries = 0; existsSync(root) && identity(marker.pid) === marker.start && tries < 100; tries++) await delay(100);
    if (existsSync(root)) {
      await stopPreviewService(root, marker.home);
      if (identity(marker.pid) !== marker.start) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
  if (!values.watchdog && marker.watchdog && identity(marker.watchdog.pid) === marker.watchdog.start) process.kill(marker.watchdog.pid, 'SIGTERM');
  if (!values.watchdog) console.log(marker.language === 'ja' ? '試用環境を停止・削除しました。' : 'Preview stopped and removed.');
  process.exit(0);
}
const port = values.port === undefined ? 0 : Number(values.port), minutes = Number(values.minutes);
if (!Number.isInteger(port) || port < 0 || port > 65535 || port === 5499) throw new Error('Choose a free preview port other than 5499.');
if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) throw new Error('Preview duration must be 1–120 minutes.');
const root = realpathSync(mkdtempSync('/tmp/alpacawork-first-run-')), home = join(root, 'home'), bin = join(root, 'bin');
for (const path of [home, bin]) mkdirSync(path, { mode: 0o700 });
// Start from an allowlist. In particular no Run mark, provider key, SSH agent, or inherited XDG/provider path crosses this boundary.
const env: NodeJS.ProcessEnv = { HOME: home, USER: process.env.USER, LOGNAME: process.env.LOGNAME, LANG: values.lang === 'en' ? 'en_US.UTF-8' : 'ja_JP.UTF-8',
  XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
  XDG_STATE_HOME: join(home, '.local/state'), XDG_RUNTIME_DIR: join(home, '.run'), TMPDIR: root,
  GIT_SSH_COMMAND: '/bin/false', GIT_SSH: '/bin/false', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  COREPACK_ENABLE_NETWORK: '0', npm_config_update_notifier: 'false', npm_config_registry: 'http://127.0.0.1:9/' };
for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key];
// Preserve only the fact that setup was launched over SSH, so it does not try a
// browser on the server. The preview needs no remote address or account details.
for (const key of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) if (process.env[key]) env[key] = '1';
// The guide's demo request, as the stand-in agent recognizes it: it follows its script only for this one.
const demo = JSON.parse(readFileSync(join(repo, `packages/i18n/src/locales/${values.lang}/tree.json`), 'utf8')).guide.example as string;
const examples = [{ name: 'demo', label: japanese ? '"Hello" を2種類のフォントで表示する' : 'Show "Hello" in two fonts', words: demo.split('\n').at(-1)! }];
const marker = { root, home, port, language: values.lang, examples, exampleDelayMs: values.check ? 4000 : 12000, project: null as string | null, pid: process.pid, start: identity(process.pid), expiresAt: Date.now() + minutes * 60_000, watchdog: null as { pid: number; start: string | null } | null };
writeFileSync(join(root, 'preview.json'), JSON.stringify(marker), { mode: 0o600 });
let child: ReturnType<typeof spawn> | undefined, watchdog: ReturnType<typeof spawn> | undefined, stopped = false, systemctl: string | undefined, detached = false;
function interrupt() { stopped = true; child?.kill('SIGTERM'); }
process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt); process.on('SIGHUP', interrupt);
const execute = (command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; interactive?: boolean; capture?: boolean } = {}) => new Promise<string>((done, reject) => {
  if (stopped) return reject(new Error('Preview stopped.'));
  child = spawn(command, args, { cwd: options.cwd ?? repo, env: options.env ?? process.env, stdio: options.interactive ? 'inherit' : options.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] });
  const chunks: Buffer[] = [];
  if (options.capture) { child.stdout!.on('data', chunk => chunks.push(chunk)); child.stderr!.on('data', chunk => chunks.push(chunk)); }
  child.once('error', reject); child.once('close', code => { child = undefined; const output = Buffer.concat(chunks).toString('utf8'); code === 0 ? done(output) : reject(new Error(`${command} exited with ${code}${output ? '\n' + output : ''}`)); });
});
async function runPreview() {
  try {
    watchdog = spawn(process.execPath, [script, '--watchdog', root], { detached: true, stdio: 'ignore', env: { HOME: home } });
    marker.watchdog = { pid: watchdog.pid!, start: identity(watchdog.pid!) };
    writeFileSync(join(root, 'preview.json'), JSON.stringify(marker), { mode: 0o600 });
    // Never invoke pnpm after changing HOME. Builds use the existing dependency/tool cache.
    await execute('pnpm', ['build']);
    const { assembleFixtureDistribution } = await import('../tests/helpers/distribution-fixture.ts');
    const { installSetupSystemctl } = await import('../tests/helpers/setup-systemctl.ts');
    const { installAgentStub } = await import('../tests/helpers/agent-stub.ts');
    // setup prepends its real Node directory to the service PATH. A private copy keeps that directory isolated too.
    const node = join(bin, 'node'); copyFileSync(process.execPath, node);
    env.PATH = `${bin}:${installAgentStub(root, 'claude')}`;
    // Kinds with no sign-in check of their own (Grok Build and pi) are left out, as on a PC without them: a
    // stand-in that answers --version would read as installed, which the preview cannot make true.
    for (const kind of ['grok', 'pi']) rmSync(join(root, 'agent-bin', kind), { force: true });
    const network = join(root, 'network.mjs'); copyFileSync(join(repo, 'scripts/first-run-preview/network.mjs'), network);
    copyFileSync(join(repo, 'scripts/first-run-preview/agent.mjs'), join(root, 'actor.mjs'));
    copyFileSync(join(repo, 'scripts/first-run-preview/scenario.mjs'), join(root, 'scenario.mjs'));
    systemctl = join(bin, 'systemctl'); installSetupSystemctl(systemctl, { nodeImports: [network] });
    for (const [name, status] of [['codex', 0], ['claude', 1]] as const) writeFileSync(join(bin, name),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Synthetic ${name}"; exit 0; fi\nexit ${status}\n`, { mode: 0o700 });
    // No remote source fetch or provider status lookup can fall through to the caller's tools.
    for (const command of ['git', 'npx', 'tailscale', 'tailscale.exe', 'gh', 'ssh', 'systemd-run']) writeFileSync(join(bin, command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const { SKILL_OFFERS } = await import('@alpacawork/contract');
    const { skillInstallCommand } = await import('../apps/backend/test-dist/installation/first-run-skills.js');
    const remoteSkills = SKILL_OFFERS.filter(offer => offer.from.kind === 'repo').map(offer => ({ name: offer.name, args: skillInstallCommand(offer.name) }));
    writeFileSync(join(bin, 'npx'), `#!${node}
  import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
  import { join, dirname } from 'node:path';
  const root = dirname(process.env.HOME ?? '');
  if (!/^\\/tmp\\/alpacawork-first-run-[A-Za-z0-9]+$/.test(root)) throw new Error('Expected preview HOME');
  const marker = JSON.parse(readFileSync(join(root, 'preview.json'), 'utf8'));
  if (marker.home !== process.env.HOME || marker.root !== root) throw new Error('Preview ownership mismatch');
  const offer = ${JSON.stringify(remoteSkills)}.find(offer => JSON.stringify(offer.args) === JSON.stringify(process.argv.slice(2)));
  if (!offer) throw new Error('Unsupported preview installer arguments');
  const folder = join(marker.home, '.agents/skills', offer.name); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), '---\\nname: ' + offer.name + '\\ndescription: Synthetic preview placeholder\\n---\\n# Synthetic preview skill\\nThis disposable file demonstrates installation. It contains no real skill instructions.\\n');
  `, { mode: 0o700 });
    if (values.check) {
      writeFileSync(join(bin, 'xdg-open'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(root, 'opened-url'))},process.argv[2]);\n`, { mode: 0o700 });
      env.DISPLAY ??= ':0'; // Setup starts xdg-open only on a desktop; the stand-in records the URL instead.
    }
    else if (existsSync('/usr/bin/xdg-open')) symlinkSync('/usr/bin/xdg-open', join(bin, 'xdg-open'));
    const artifact = join(root, 'distribution');
    assembleFixtureDistribution(repo, join(root, 'build'), artifact, undefined, built => {
      // Only this disposable, unpublished image uses the actor. The checkout's bridge stays intact.
      writeFileSync(join(built, 'apps/agent-cli/dist/cli.js'), `import ${JSON.stringify(network)};\nimport ${JSON.stringify(join(root, 'actor.mjs'))};\n`);
    });
    const { probeServicePort, serviceDefinition } = await import('../apps/backend/test-dist/installation/setup.js');
    const selected = await probeServicePort(port);
    if (selected === 5499) throw new Error('Refusing production port 5499.');
    marker.port = selected; writeFileSync(join(root, 'preview.json'), JSON.stringify(marker));
    const command = ['--import', network, join(artifact, 'bin/alpacawork.mjs'), 'setup', '--lang', values.lang!, '--port', String(selected), ...(values['no-open'] ? ['--no-open'] : [])];
    const { InstallationStore, installationPath } = await import('../apps/backend/test-dist/installation/store.js');
    const installation = new InstallationStore(installationPath(env));
    if (values.check) {
      const config = join(root, 'terminal.json'), output = join(root, 'terminal-result.json');
      writeFileSync(config, JSON.stringify({ home, cwd: root, env, output, answer: 'enter', command: [node, ...command] }));
      await execute(process.execPath, [join(repo, 'tests/helpers/setup-terminal.ts'), config], { env, capture: true });
      const terminal = JSON.parse(readFileSync(output, 'utf8'));
      if (terminal.status !== 0) throw new Error(terminal.transcript);
      if (terminal.confirmations !== 1) throw new Error('Initial setup did not receive its terminal confirmation.');
      if (!installation.read()?.service) throw new Error('Terminal setup did not install its service.');
      console.log(terminal.transcript);
      // Keep both approval paths covered even when the check itself was invoked with --yes.
      // Capturing the second setup preserves its evidence without printing the URL twice.
      const automatic = await execute(node, [...command.filter(arg => arg !== '--no-open'), '--yes', '--no-open'], { cwd: root, env, capture: true });
      writeFileSync(join(root, 'terminal-yes-result.json'), JSON.stringify({ status: 0, transcript: automatic, terminal: false }));
      if (/\[Y\/n\]/.test(automatic)) throw new Error('Setup --yes still requested confirmation.');
    } else await execute(node, [...command, ...(values.yes ? ['--yes'] : [])], { cwd: root, env, interactive: true });
    const record = installation.read();
    if (!record) {
      if (values.check) throw new Error('Automatic setup did not install its service.');
      return; // Declining interactive setup is successful; the same finally removes the preview.
    }
    const service = serviceDefinition(record, installationPath(env));
    // Check the service's actual search order before any installation or provider request.
    for (const command of ['npx', 'git', 'tailscale', 'gh', 'ssh', 'systemd-run', 'claude', 'codex']) {
      const executable = service.environment.PATH!.split(':').map(directory => join(directory, command)).find(path => existsSync(path));
      if (!executable || !realpathSync(executable).startsWith(root + '/')) throw new Error(`Preview command escaped isolation: ${command}`);
    }
    // The kinds left out stay out: a real one on the service PATH would be run by the availability check.
    for (const command of ['grok', 'pi'])
      if (service.environment.PATH!.split(':').some(directory => existsSync(join(directory, command)))) throw new Error(`Preview found a real ${command} on its PATH`);
    const url = `http://127.0.0.1:${selected}/`;
    const checked = async (path: string) => { const response = await fetch(new URL(path, url)); if (!response.ok) throw new Error(`${path}: ${response.status}`); return response; };
    await checked('/');
    if (!existsSync(join(home, '.agents/skills/alpacawork/SKILL.md'))) throw new Error('Setup did not install the base skill.');
    const first = await (await checked('/api/first-run')).json();
    if (!first.state || first.state.finishedAt !== null) throw new Error('Fresh setup state was not returned.');
    marker.project = first.state.project; writeFileSync(join(root, 'preview.json'), JSON.stringify(marker));
    const probeStarted = Date.now();
    const skills = await (await checked('/api/skills')).json();
    const { SKILL_OFFERS: offers } = await import('@alpacawork/contract');
    const remote = (name: string) => offers.some(offer => offer.name === name && offer.from.kind === 'repo');
    if (Date.now() - probeStarted > 3000 || skills.skills.some(skill => remote(skill.name) && skill.available !== 'unknown'))
      throw new Error('The preview skill listing was slow or returned unexpected remote availability.');
    const settings = await (await checked('/api/commands/settings/get')).json();
    if (settings.values.language !== values.lang || settings.values['ai.language'] !== values.lang) throw new Error('Setup did not initialize the selected language.');
    if (values.check && !values['no-open'] && !env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY) {
      for (let tries = 0; !existsSync(join(root, 'opened-url')) && tries < 50; tries++) await delay(20);
      if (readFileSync(join(root, 'opened-url'), 'utf8') !== url) throw new Error('Setup did not request the browser URL.');
    }
    if (values.check) {
      const { checkJourney } = await import('./first-run-preview/check.ts');
      await checkJourney(url, root, values.lang!, Number(values.width));
    }
    const deadline = new Date(marker.expiresAt).toLocaleTimeString(japanese ? 'ja-JP' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
    const host = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hostname()) ? hostname() : 'THIS_PC';
    const forwarding = `ssh -N -L ${selected}:127.0.0.1:${selected} ${host}`;
    console.log(japanese
      ? `試用: AIは代役です。${deadline}${values.detach && !values.check ? 'に停止します。' : ' またはCtrl-Cで停止します。'}\n停止: node scripts/try-first-run.ts --stop ${root}\n別のPCから: ${forwarding}`
      : `Preview: stand-in AI only. Stops at ${deadline}${values.detach && !values.check ? '.' : ' or on Ctrl-C.'}\nStop: node scripts/try-first-run.ts --stop ${root}\nFrom another PC: ${forwarding}`);
    if (values.detach && !values.check) {
      // Setup and its approval stay on the caller's terminal. The existing watchdog
      // owns the same stop-and-remove path after this launcher exits.
      if (stopped || identity(watchdog.pid!) !== marker.watchdog!.start) throw new Error('Preview watchdog exited before detach.');
      detached = true;
      watchdog.unref();
    } else if (!values.check) while (!stopped) await delay(250);
  } finally {
    if (!detached) {
      child?.kill('SIGTERM');
      if (systemctl) await stopPreviewService(root, home);
      watchdog?.kill('SIGTERM');
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      console.log(japanese ? '試用環境を停止・削除しました。' : 'Preview stopped and removed.');
    }
  }
}
await runPreview();
