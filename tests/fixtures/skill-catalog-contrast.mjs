/** Real CLIs are comparison subjects only. The parent blocks socket/connect syscalls. */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { coordinatorSkills } from '../../apps/backend/test-dist/coordinator/skills.js';
import { coordinatorCwd } from '../../apps/backend/test-dist/runs/execution-control.js';
const root = process.argv[2], home = join(root, 'home'), config = join(root, 'claude'), code = join(root, 'codex'), repo = join(root, 'repo'),
  workspace = join(repo, 'sub'), cwd = coordinatorCwd(workspace);
const put = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); return path; };
let outOfForm = false;
for (const path of [home, config, code, cwd, join(repo, '.git/objects'), join(repo, '.git/refs/heads')]) mkdirSync(path, { recursive: true });
put(join(repo, '.git/HEAD'), 'ref: refs/heads/main\n'); put(join(repo, '.git/config'), '[core]\nrepositoryformatversion=0\n');
const skill = (folder, name, description = 'One line', extra = '') => put(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\nFixture only.\n`);
const hook = join(root, 'hook-ran');
const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(hook)},'ran')`)}`;
put(join(config, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } }));
put(join(repo, '.claude/settings.local.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] } }));
put(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { trap: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(hook)},'mcp')`] } } }));
// A contrast may start a CLI, but it must neutralize hooks and MCP in every configuration layer.
const mcp = join(root, 'empty-mcp.json'); put(mcp, '{"mcpServers":{}}');
const env = { HOME: home, PATH: process.env.PATH, USER: 'fixture', CLAUDE_CONFIG_DIR: config, CODEX_HOME: code, CODEX_SQLITE_HOME: code, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
skill(join(config, 'skills/same'), 'same', 'Personal winner'); skill(join(repo, '.claude/skills/same'), 'same', 'Project loser');
skill(join(repo, '.claude/skills/parent'), 'parent', '>\n  Folded\n  description');
skill(join(config, 'skills/colon'), 'colon', 'Video craft: generate and revise');
skill(join(config, 'skills/hidden'), 'hidden', 'Hidden', 'user-invocable: false\n');
skill(join(config, 'skills/manual'), 'manual', 'Manual', 'disable-model-invocation: true\n');
put(join(config, 'commands/group/legacy.md'), '---\ndescription: Legacy nested\n---\nFixture');
put(join(config, 'commands/plain.md'), 'Do the task now.\n');
skill(join(code, 'skills/code'), 'code'); skill(join(home, '.agents/skills/personal'), 'personal');
skill(join(repo, '.agents/skills/project'), 'project', '>\n  Folded\n  description');
skill(join(code, 'skills/colon'), 'colon', 'Video craft: generate and revise');
skill(join(code, 'skills/explicit-codex'), 'explicit-codex', 'Explicit Codex invocation', 'user-invocable: false\ndisable-model-invocation: true\n');
const disabled = join(code, 'skills/disabled'); skill(disabled, 'disabled');
put(join(code, 'config.toml'), `[[skills.config]]\npath = ${JSON.stringify(join(disabled, 'SKILL.md'))}\nenabled = false\n`);
async function query(provider, at = cwd) {
  const args = provider === 'claude' ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', mcp] : ['app-server'];
  const child = spawn(provider, args, { cwd: at, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  put(join(root, 'pids'), (existsSync(join(root, 'pids')) ? readFileSync(join(root, 'pids'), 'utf8') : '') + child.pid + '\n');
  let buffer = ''; const calls = new Map();
  child.stdout.on('data', data => { buffer += data; let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); try { const msg = JSON.parse(line); calls.get(String(msg.id ?? msg.response?.request_id))?.(msg); } catch {} } });
  const ask = (id, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${provider} metadata timeout`)), 20000);
    calls.set(String(id), value => { clearTimeout(timer); resolve(value); }); child.stdin.write(JSON.stringify(message) + '\n');
  });
  try {
    if (provider === 'claude') { const result = await ask('init', { type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } }); return result.response.response.commands.filter(item => !item.builtin); }
    await ask(1, { id: 1, method: 'initialize', params: { clientInfo: { name: 'catalog-contrast', version: '1' }, capabilities: { experimentalApi: false } } });
    child.stdin.write('{"method":"initialized"}\n'); const result = await ask(2, { id: 2, method: 'skills/list', params: { cwds: [at], forceReload: true } });
    if (!outOfForm) assert.deepEqual(result.result.data[0].errors, []); return result.result.data[0].skills.filter(item => item.enabled !== false);
  } finally {
    child.stdin.destroy(); child.stdout.destroy();
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}
// The admitted adapter is explicit, never inferred from argv.
const input = profile => ({ profile, adapter: profile, root: workspace, argv: profile === 'claude' ? ['claude', '-p'] : ['alpacawork-agent', 'codex', '--json'], env, session: null });
skill(join(config, 'skills/masked'), 'masked', 'Personal hidden', 'user-invocable: false\n'); skill(join(repo, '.claude/skills/masked'), 'masked', 'Project masked');
const cliClaude = await query('claude'), cliCodex = await query('codex');
assert.equal(existsSync(hook), false, 'the isolated CLI contrast must not execute hooks or MCP');
const claude = await coordinatorSkills(input('claude')), codex = await coordinatorSkills(input('codex'));
assert.equal(claude.status, 'ready'); assert.equal(codex.status, 'ready');
const normalize = items => items.map(item => ({ name: item.name, description: item.description.replace(/ \((?:user|project)\)$/, '') })).sort((a,b) => a.name.localeCompare(b.name, 'en'));
// Manual-only commands are deliberately excluded: the UI sends a mention, not a CLI slash command.
assert.deepEqual(normalize(claude.skills), normalize(cliClaude.filter(item => !['manual', 'hidden'].includes(item.name))));
assert.deepEqual(normalize(codex.skills), normalize(cliCodex));
// Confirm the config path boundary as well as disabled SKILL.md files.
put(join(code, 'config.toml'), `[[skills.config]]\npath = ${JSON.stringify(disabled)}\nenabled = false\n`);
const directoryDisabled = await query('codex');
const directoryCatalog = await coordinatorSkills(input('codex'));
assert.equal(directoryCatalog.status, 'ready');
assert.deepEqual(normalize(directoryCatalog.skills), normalize(directoryDisabled));
// Linked worktree discovery is resolved from pointers, without running git in the product.
const worktree = join(root, 'worktree'), gitdir = join(repo, '.git/worktrees/linked');
mkdirSync(coordinatorCwd(worktree), { recursive: true });
put(join(worktree, '.git'), `gitdir: ${gitdir}\n`); put(join(gitdir, 'commondir'), '../..\n');
put(join(gitdir, 'gitdir'), join(worktree, '.git') + '\n'); put(join(gitdir, 'HEAD'), 'ref: refs/heads/main\n');
const cliWorktree = await query('claude', coordinatorCwd(worktree));
const worktreeCatalog = await coordinatorSkills({ ...input('claude'), root: worktree });
assert.equal(worktreeCatalog.status, 'ready');
assert.deepEqual(normalize(worktreeCatalog.skills), normalize(cliWorktree.filter(item => !['manual', 'hidden'].includes(item.name))));
// Entries out of form: each CLI's list is the catalog's, name and words alike. Claude's other layers are as above.
const projectSkills = join(repo, '.claude/skills');
for (const base of [join(config, 'skills'), join(code, 'skills')]) {
  put(join(base, 'f-malformed/SKILL.md'), '---\nname: n-malformed\ndescription: [never closed\n---\nBody\n');
  put(join(base, 'f-nofront/SKILL.md'), 'Line without frontmatter.\n');
  put(join(base, 'f-nodesc/SKILL.md'), '---\nname: n-nodesc\n---\nBody line.\n');
  put(join(base, 'f-noname/SKILL.md'), '---\ndescription: no name\n---\nBody line.\n');
  put(join(base, 'f-oversized/SKILL.md'), `---\nname: n-oversized\ndescription: Big\n---\n${'x'.repeat(300 * 1024)}`);
  put(join(base, 'f-dupkey/SKILL.md'), '---\nname: n-dupkey\nname: n-dupkey2\ndescription: d\n---\nBody\n');
  put(join(base, 'f-flag/SKILL.md'), '---\nname: n-flag\ndescription: d\nuser-invocable: "false"\n---\nBody\n');
  put(join(base, 'f-openquote/SKILL.md'), '---\nname: n-openquote\ndescription: "never closed\n---\nBody line.\n');
  put(join(base, 'f-indent/SKILL.md'), '---\nname: n-indent\n   description: indented\n---\nBody line.\n');
  put(join(base, 'f-list/SKILL.md'), '---\nname: n-list\ndescription: d\nitems:\n  - a\n b\n---\nBody line.\n');
  put(join(base, 'f-openspace/SKILL.md'), '--- \nname: n-openspace\ndescription: d\n---\nBody line.\n');
  put(join(base, 'f-closespace/SKILL.md'), '---\nname: n-closespace\ndescription: d\n--- \nBody line.\n');
  put(join(base, 'f-hidespace/SKILL.md'), '---\nname: n-hidespace\ndescription: d\nuser-invocable: false\n--- \nBody line.\n');
  put(join(base, 'f-bom/SKILL.md'), '\uFEFF---\nname: n-bom\ndescription: d\n---\nBody line.\n');
  put(join(base, 'f-title/SKILL.md'), '---\nname: n-title\n---\n# A title\n');
  put(join(base, 'f-number/SKILL.md'), '---\nname: 123\ndescription: 456\n---\nBody line.\n');
  put(join(base, 'f-flagno/SKILL.md'), '---\nname: n-flagno\ndescription: d\nuser-invocable: no\n---\nBody line.\n');
  put(join(base, 'f-flagyes/SKILL.md'), '---\nname: n-flagyes\ndescription: d\nuser-invocable: yes\n---\nBody line.\n');
  skill(join(base, 'f-long'), 'n'.repeat(80));
  chmodSync(put(join(base, 'f-closed/SKILL.md'), 'x'), 0o044);
  symlinkSync(join(root, 'missing'), join(base, 'f-dangling')); symlinkSync(join(base, 'f-loop'), join(base, 'f-loop'));
}
skill(join(code, 'skills/f-policy'), 'n-policy', 'd', 'policy:\n  allow_implicit_invocation: false\n');
put(join(config, 'skills/m-malformed/SKILL.md'), '---\nname: m-malformed\ndescription: [personal\n---\nBody\n'); skill(join(projectSkills, 'm-malformed'), 'm-malformed', 'Project');
put(join(config, 'skills/folder-x/SKILL.md'), '---\nname: rev\ndescription: "personal\n---\nPersonal body.\n'); skill(join(projectSkills, 'rev'), 'rev', 'Project');
put(join(config, 'skills/m-flag/SKILL.md'), '---\nname: m-flag\ndescription: d\nuser-invocable: "false"\n---\nBody\n'); skill(join(projectSkills, 'm-flag'), 'm-flag', 'Project');
chmodSync(put(join(config, 'skills/m-closed/SKILL.md'), 'x'), 0o044); skill(join(projectSkills, 'm-closed'), 'm-closed', 'Project');
symlinkSync(join(root, 'missing'), join(config, 'skills/m-dangling')); skill(join(projectSkills, 'm-dangling'), 'm-dangling', 'Project');
skill(join(config, 'skills/both'), 'both', 'A skill'); put(join(config, 'commands/both.md'), '---\ndescription: A command\n---\nBody\n');
skill(join(config, 'skills/twin-a'), 'twin', 'Twin'); skill(join(config, 'skills/twin-b'), 'twin', 'Twin');
outOfForm = true;
const once = items => [...new Map(items.map(item => [item.name, item])).values()];
assert.deepEqual(normalize(once((await coordinatorSkills(input('claude'))).skills)), normalize(once((await query('claude')).filter(item => !['manual', 'hidden'].includes(item.name)))));
assert.deepEqual(normalize((await coordinatorSkills(input('codex'))).skills), normalize(await query('codex')));
// Same-name distinct definitions are returned by Codex, but cannot be routed safely by a $name mention: not offered.
skill(join(home, '.agents/skills/duplicate'), 'code');
assert.equal((await coordinatorSkills(input('codex'))).skills.some(item => item.name === 'code'), false);
put(join(config, 'settings.local.json'), '{"enabledPlugins":{"unknown@fixture":true}}');
assert.equal((await coordinatorSkills(input('claude'))).reason, 'plugins');
assert.equal(existsSync(hook), false);
console.log(JSON.stringify({ claude: normalize(claude.skills), codex: normalize(codex.skills), worktreeCount: worktreeCatalog.skills.length, directoryDisableCount: directoryCatalog.skills.length, hooks: 'not executed', network: 'socket/connect denied by parent', modelInput: false }));
