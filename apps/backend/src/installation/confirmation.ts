/** One terminal confirmation. The caller supplies observed placement and service facts.
 * It runs before any setup or uninstall change; approval is not evidence that the change completed. */
import { isAbsolute, normalize } from 'node:path';
import { serverText, type ServerLocale, type ServerText } from '@alpacawork/i18n/server';
import { uiLocaleFromEnvironment } from '@alpacawork/core/ui-language';
import type { AgentSkillLink } from './agent-skill-links.js';
import type { SetupPlan } from './public-setup.js';

/** One recorded installation fact the terminal is asked to replace; `from` is null where none was recorded. */
export type InstallationChange = { fact: 'port' | 'publicHost' | 'node' | 'path'; from: string | null; to: string };
/** With `changes`, the request re-approves a recorded service and installs nothing: the array may be empty when only the registration is missing. */
export type InstallationConfirmationRequest = Pick<SetupPlan, 'workspace' | 'releases' | 'existing'> & { service: string; agents: readonly string[]; skills: readonly { name: string; destination: string; action: 'install' | 'replace' | 'keep' }[]; links?: readonly AgentSkillLink[]; notes?: readonly string[]; overwrite?: readonly string[]; resuming?: boolean; application?: {current: string | null; target: string}; changes?: readonly InstallationChange[]; showReleases?: boolean };
export type ApprovedInstallation = { approved: true; request: InstallationConfirmationRequest };
export type RefusedInstallation = { approved: false; reason: 'cancelled' | 'eof' | 'invalid_input' | 'interrupted' | 'not_terminal' };
export type InstallationTerminal = {
  input: Pick<NodeJS.ReadStream, 'isTTY' | 'setRawMode' | 'on' | 'off' | 'resume' | 'pause'>;
  output: Pick<NodeJS.WriteStream, 'isTTY' | 'write' | 'on' | 'off'> & { hasColors?: () => boolean };
  discardPendingInput: () => void;
  env: Readonly<Record<string, string | undefined>>;
};

/** Shorten paths only at a HOME boundary; unsafe text keeps the diagnostic escaping used elsewhere. */
function setupPath(path: string, home: string | undefined): string {
  const shown = displayInstallationPath(path);
  if (shown !== path || !home) return shown;
  return path === home ? '~' : path.startsWith(home.replace(/\/+$/, '') + '/') ? '~' + path.slice(home.replace(/\/+$/, '').length) : path;
}
/** Catalog labels use Latin or Japanese characters. Count full-width labels when aligning their values. */
const labelWidth = (text: string) => Array.from(text).reduce((width, c) => width + (/[^\u0000-\u00ff]/u.test(c) ? 2 : 1), 0);

function installationRows(request: InstallationConfirmationRequest, t: ServerText, home?: string): string[] {
  const labels = { data: t('server:setup.row.data'), releases: t('server:setup.row.releases'), service: t('server:setup.row.service'),
    agents: t('server:setup.row.agents'), skill: t('server:setup.row.skill'), overwrite: t('server:setup.row.overwrite'), resume: t('server:setup.row.resume'), warning: t('server:setup.row.warning') };
  const facts = { port: t('server:setup.fact.port'), publicHost: t('server:setup.fact.publicHost'), node: t('server:setup.fact.node'), path: t('server:setup.fact.path') };
  const path = (value: string) => setupPath(value, home);
  const rows: [string, string][] = [
    [labels.data, t('server:setup.value.data', { path: path(request.workspace), state: request.existing ? t('server:setup.data.existing') : t('server:setup.data.new') })],
    ...(request.showReleases ? [[labels.releases, path(request.releases)] as [string, string]] : []),
    [labels.service, request.service],
    ...(request.changes ?? []).map(change => [facts[change.fact], `${change.from === null ? t('server:setup.change.none') : path(change.from)} → ${path(change.to)}`] as [string, string]),
    ...(!request.application?.current && !request.changes ? [[labels.agents, request.agents.length ? request.agents.join(t('server:setup.listSeparator')) : t('server:setup.agents.none')] as [string, string]] : []),
    ...request.skills.map(skill => [labels.skill, skill.action === 'install' ? path(skill.destination) : t('server:setup.value.skill', { path: path(skill.destination), action: skill.action === 'keep' ? t('server:setup.skillAction.keep') : t('server:setup.skillAction.replace') })] as [string, string]),
    ...(request.links ?? []).map(link => [link.action === 'conflict' ? labels.warning : '', link.action === 'conflict'
      ? t('server:setup.value.linkConflict', { path: path(link.path) })
      : link.action === 'keep' ? t('server:setup.value.linkExisting', { path: path(link.path) }) : t('server:setup.value.link', { path: path(link.path) })] as [string, string]),
    ...(request.notes ?? []).map(line => ['', line] as [string, string]),
    ...(request.overwrite ?? []).map(line => [labels.overwrite, home ? line.split(home + '/').join('~/') : line] as [string, string]),
    ...(request.resuming ? [[labels.resume, t('server:setup.value.resume')] as [string, string]] : []),
  ];
  const width = Math.max(...rows.map(([label]) => labelWidth(label)));
  return rows.map(([label, value]) => label + ' '.repeat(width - labelWidth(label) + 2) + value);
}

/** What uninstall removes, in the order it removes it, and what it leaves. `subject` is a path, or the service as its manager names it. */
export type UninstallRemoval = { kind: 'service' | 'link' | 'skill' | 'receipt' | 'stage' | 'state' | 'releases' | 'setting' | 'config'; subject: string };
export type UninstallKept = { kind: 'data' | 'holds_data' | 'record' | 'not_ours' | 'skills_unknown'; subject: string };
export type UninstallConfirmationRequest = { remove: readonly UninstallRemoval[]; keep: readonly UninstallKept[] };
type UninstallItem = UninstallRemoval | UninstallKept;
/** One line per kind: a kind is either removed or kept, and the catalog's line carries that word, its label and the reason. */
function uninstallRow(item: UninstallItem, t: ServerText): string {
  const subject = displayInstallationPath(item.subject);
  const rows: Record<UninstallItem['kind'], string> = {
    service: t('server:uninstall.row.service', { subject }), link: t('server:uninstall.row.link', { subject }), skill: t('server:uninstall.row.skill', { subject }),
    receipt: t('server:uninstall.row.receipt', { subject }), stage: t('server:uninstall.row.stage', { subject }), state: t('server:uninstall.row.state', { subject }),
    releases: t('server:uninstall.row.releases', { subject }), setting: t('server:uninstall.row.setting', { subject }), config: t('server:uninstall.row.config', { subject }),
    data: t('server:uninstall.row.data', { subject }), holds_data: t('server:uninstall.row.holdsData', { subject }), record: t('server:uninstall.row.record', { subject }),
    not_ours: t('server:uninstall.row.notOurs', { subject }), skills_unknown: t('server:uninstall.row.skillsUnknown', { subject }),
  };
  return rows[item.kind];
}
/** The same line says what stays before the person approves and after the removal finished. */
export const uninstallKeptRows = (keep: readonly UninstallKept[], t: ServerText): string[] => keep.map(item => uninstallRow(item, t));

// A line break or escape sequence in a shown value could rewrite the screen the person approves.
// ZWNJ/ZWJ shape legitimate script/emoji names; other format controls can hide or reorder what is approved.
const UNPRINTABLE = /[\p{Cc}\p{Zl}\p{Zp}]|(?:(?![\u200c\u200d])\p{Cf})/u;
/** Diagnostic paths are text, never shell commands. Keep normal paths exact and mark escaped ones. */
export function displayInstallationPath(path: string): string {
  if (!UNPRINTABLE.test(path)) return path;
  return '[escaped path; not a command] ' + JSON.stringify(Array.from(path, c =>
    UNPRINTABLE.test(c) ? `\\u{${c.codePointAt(0)!.toString(16)}}` : c).join(''));
}
/** Inspected after placement: a link that is still a conflict means the person's own content stayed at that path. */
export function skillLinkConflicts(links: readonly AgentSkillLink[], lang: ServerLocale): string[] {
  const t = serverText(lang);
  return links.filter(link => link.action === 'conflict').map(link => t('server:skillLinks.conflict', { path: displayInstallationPath(link.path) }));
}
/**
 * The caller checked these values before asking, and no person typed them here. A bad value is that program's
 * mistake, so it is a TypeError for its authors rather than a Problem with a public reason.
 */
function assertRequest(request: InstallationConfirmationRequest): void {
  const paths = [request.workspace, request.releases, ...request.skills.map(skill => skill.destination), ...(request.links ?? []).flatMap(link => [link.path, link.target])];
  if (paths.some(path => !isAbsolute(path) || normalize(path) !== path || UNPRINTABLE.test(path)))
    throw new TypeError('Confirmation needs the absolute paths it will use');
  if (typeof request.existing !== 'boolean') throw new TypeError('Confirmation needs the inspected workspace state');
  if (!request.service || [request.service, ...request.agents, ...request.skills.map(skill => skill.name), ...request.notes ?? [], ...request.overwrite ?? [], ...(request.application ? [request.application.current ?? 'new',request.application.target] : []),
      ...(request.changes ?? []).flatMap(change => [change.from ?? 'none', change.to])].some(value => !value || UNPRINTABLE.test(value)))
    throw new TypeError('Confirmation needs printable observed service, AI and skill facts');
}

const CTRL_C = 3, CTRL_D = 4, LINE_FEED = 10, CARRIAGE_RETURN = 13;
const INTERRUPTS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

type Answer = 'enter' | Exclude<RefusedInstallation['reason'], 'not_terminal'>;
function answerOf(bytes: Buffer, allowYes = false): Answer {
  if (bytes.length === 1 && (bytes[0] === CARRIAGE_RETURN || bytes[0] === LINE_FEED)) return 'enter';
  if (bytes.includes(CTRL_C)) return 'cancelled';
  if (bytes.includes(CTRL_D)) return 'eof';
  if (allowYes && /^[yY](?:\r?\n|\r)?$/.test(bytes.toString('utf8'))) return 'enter';
  return 'invalid_input';
}

/** Whether the text reached the output. A failed write reports to its callback first, and then as 'error'. */
function show(output: InstallationTerminal['output'], text: string, afterWrite?: () => void): Promise<boolean> {
  return new Promise(resolve => {
    let shown = true, completed = false;
    const failed = () => { shown = false; };
    const written = (error?: Error | null) => {
      if (error) failed();
      if (completed) return;
      completed = true;
      if (shown) afterWrite?.();
      setImmediate(() => { output.off('error', failed); resolve(shown); });
    };
    output.on('error', failed);
    try { output.write(text, written); }
    catch { failed(); written(); }
  });
}

export async function confirmInstallation(request: InstallationConfirmationRequest,
  terminal: InstallationTerminal = defaultTerminal(),
  options: { yes?: boolean } = {},
): Promise<ApprovedInstallation | RefusedInstallation> {
  assertRequest(request);
  const t = serverText(uiLocaleFromEnvironment(terminal.env));
  const versions = { current: request.application?.current ?? '', version: request.application?.target ?? '' };
  const title = request.changes ? t('server:setup.title.change', versions)
    : request.application?.current ? request.application.current === request.application.target ? t('server:setup.title.configure', versions) : t('server:setup.title.update', versions)
    : t('server:setup.title.install', versions);
  const answer = await confirmTerminal({ title, rows: installationRows(request, t, terminal.env.HOME), prompt: request.changes ? t('server:setup.changePrompt') : t('server:setup.prompt') }, t, terminal, { yes: options.yes, allowYes: true });
  return answer.approved ? { approved: true, request } : answer;
}
/** Every subject is shown escaped rather than refused: a strange path must not leave a person without a way out. */
export async function confirmUninstall(request: UninstallConfirmationRequest,
  terminal: InstallationTerminal = defaultTerminal(), options: { yes?: boolean } = {}): Promise<{ approved: true } | RefusedInstallation> {
  const t = serverText(uiLocaleFromEnvironment(terminal.env));
  return confirmTerminal({ title: t('server:uninstall.title'), note: t('server:uninstall.note'),
    rows: [...request.remove, ...request.keep].map(item => uninstallRow(item, t)) }, t, terminal, { yes: options.yes });
}

function defaultTerminal(): InstallationTerminal {
  return { input: process.stdin, output: process.stdout, env: process.env,
    discardPendingInput: () => { while (process.stdin.read() !== null) { /* Drain the one Node reader. */ } } };
}

async function confirmTerminal(text: { title: string; rows: readonly string[]; note?: string; prompt?: string }, t: ServerText,
  terminal: InstallationTerminal, options: { yes?: boolean; allowYes?: boolean } = {}): Promise<{ approved: true } | RefusedInstallation> {
  const { input, output } = terminal, stopped = t('server:confirmation.stopped');
  if (!options.yes && (!input.isTTY || !output.isTTY)) {
    await show(output, `${stopped}\n${t('server:confirmation.notTerminal')}\n`);
    return { approved: false, reason: 'not_terminal' };
  }
  // Asked before anything is held, so a failure here has nothing to give back.
  const [bold, dim] = output.hasColors?.()
    ? [(value: string) => `\x1b[1m${value}\x1b[22m`, (value: string) => `\x1b[2m${value}\x1b[22m`]
    : [(value: string) => value, (value: string) => value];
  const rows = text.rows.map(row => `  ${row}`).join('\n');
  const body = `\n${bold(text.title)}\n\n${rows}\n\n${text.note ? text.note + '\n\n' : ''}`;
  if (options.yes) return await show(output, body) ? { approved: true } : { approved: false, reason: 'interrupted' };
  // A failure at any point, restoring the terminal included, overrides the answer already given.
  let interrupted = false, accepting = false;
  let answer: (value: Answer) => void = () => {};
  const answered = new Promise<Answer>(resolve => { answer = resolve; });
  const interrupt = () => { interrupted = true; answer('interrupted'); };
  const attempt = (step: () => unknown) => { try { step(); } catch { interrupt(); } };
  const onData = (chunk: Buffer | string) => {
    const given = answerOf(Buffer.from(chunk as Buffer), options.allowYes);
    if (accepting || given === 'cancelled' || given === 'eof') answer(given);
  };
  const onEnd = () => answer('eof');
  input.on('error', interrupt); output.on('error', interrupt);
  for (const signal of INTERRUPTS) process.on(signal, interrupt);

  attempt(() => input.setRawMode(true));
  // Drain through one reader while the screen is being written; those Enter bytes never approve.
  if (!interrupted) attempt(() => {
    terminal.discardPendingInput(); input.on('data', onData); input.on('end', onEnd); input.resume();
  });
  const bodyShown = !interrupted && await show(output, body, () => {
    // Clear queued screen-time input before the invitation, never after a visible invitation's Enter.
    if (!interrupted) attempt(terminal.discardPendingInput);
  });
  const shown = bodyShown && !interrupted && await show(output, dim(text.prompt ?? t('server:confirmation.prompt')), () => {
    // One acceptance boundary. Synchronous stdout queues invitation-time input until after this callback;
    // an asynchronous output can deliver it earlier while the reader is still refusing approval.
    accepting = true;
    if (!interrupted) attempt(() => input.resume());
  });
  if (!shown || interrupted) interrupt();
  const given = await answered;

  input.off('data', onData); input.off('end', onEnd);
  attempt(() => input.setRawMode(false));
  attempt(() => input.pause());
  // Every refusal says so and ends its line, or the shell's prompt lands on the prompt shown here.
  if (!await show(output, given === 'enter' && !interrupted ? '\n' : `\n${stopped}\n`)) interrupt();
  input.off('error', interrupt); output.off('error', interrupt);
  for (const signal of INTERRUPTS) process.off(signal, interrupt);

  if (interrupted) return { approved: false, reason: 'interrupted' };
  return given === 'enter' ? { approved: true } : { approved: false, reason: given };
}
