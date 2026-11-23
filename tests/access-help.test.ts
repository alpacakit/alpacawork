import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { privateNodeApp } from './helpers/private-node-app.ts';
import { commandCatalog } from '@alpacawork/contract/commands';
import { CLI_EXIT_CODE } from '@alpacawork/cli-kit';
import { DEFAULT_SERVER_ORIGIN } from '@alpacawork/contract/default-server';
import { ACTIONS } from '@alpacawork/contract/command-access';
import { accessHelp, describedActs } from '@alpacawork/contract/access-help';
import { reportCallerRules, urgentRecipient, replyAccess } from '@alpacawork/contract/access-boundaries';

const root = new URL('../', import.meta.url);
function cli(path: string[], backend = false, script?: string) {
  const result = spawnSync(process.execPath, script ? ['--input-type=module', '-e', script] :
    [backend ? 'apps/backend/dist/backend.js' : 'apps/cli/dist/cli.js', ...path, '-h'], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      // Help must be usable offline, even with incomplete Run credentials.
      env: { ...process.env, ALPACAWORK_SERVER: 'http://127.0.0.1:1', ALPACAWORK_RUN: 'R-invalid', ALPACAWORK_RUN_TOKEN: 'invalid' },
    });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}
const ordinary = commandCatalog.commands.map(spec => [...spec.words]);

test('all 42 ordinary and 8 backend operation helps expose access without connecting or authorizing', () => {
  const client = [...ordinary, ['server', 'show'], ['server', 'set'], ['server', 'unset'], ['run', 'stop-local']];
  const backend = [...['init', 'serve', 'maintenance'].map(name => ['workspace', name]),
    ...['build', 'rollback', 'prune', 'status'].map(name => ['release', name]), ['deploy']];
  assert.equal(client.length, 42);
  assert.equal(backend.length, 8);
  // One process per program: what a help prints comes from its path, and its real start is the entry below.
  const helps = (entry: string, paths: string[][]) => JSON.parse(cli([], false, `
    import { main } from './${entry}';
    const out = {}, write = process.stdout.write;
    for (const path of ${JSON.stringify(paths)}) {
      let text = ''; process.stdout.write = chunk => { text += chunk; return true; };
      const code = await main([...path, '-h']) ?? process.exitCode; process.stdout.write = write; process.exitCode = 0;
      if (code) throw new Error(path.join(' ') + ' -h exited ' + code);
      out[path.join(' ')] = text;
    }
    console.log(JSON.stringify(out));
  `)) as Record<string, string>;
  const groups = [[], ['task'], ['task', 'attachment']];
  const fromClient = helps('apps/cli/dist/cli.js', [...client, ...groups]), fromBackend = helps('apps/backend/dist/backend.js', [...backend, []]);
  for (const path of client) assert.match(fromClient[path.join(' ')]!, /Access[: (]/, path.join(' '));
  for (const path of backend) assert.match(fromBackend[path.join(' ')]!, /Access[: (]/, path.join(' '));
  for (const path of groups) assert.match(fromClient[path.join(' ')]!, /Before executing, read Access/);
  assert.match(fromBackend['']!, /Before executing, read Access/);
  // The programs themselves start offline with incomplete credentials.
  assert.match(cli(['task', 'report']), /Access[: (]/);
  assert.match(cli(['release', 'status'], true), /Access[: (]/);
});

test('withdrawal help at the actual CLI names only the question Task responsible and points to instruction access', () => {
  const output = cli(['task', 'report']);
  const line = output.split('\n').find(line => line.includes('--withdraw <id> (question'))!;
  assert.ok(line);
  assert.match(line, /only the Task's responsible Run \[own Task held: allowed\]/);
  assert.doesNotMatch(line, /person|coordinator|parent|member/);
  assert.match(output, /Withdrawal:.*task request -h/);
});

test('permission table changes reach the real CLI help, including held and project conditions', t => {
  const { entry } = privateNodeApp(t, 'cli');
  const source = readFileSync(entry, 'utf8');
  assert.match(source, /var ACTIONS = \{/);
  // Bundles own their contract instance. Mutate that instance, rather than a second package import.
  writeFileSync(entry, source + '\nexport { ACTIONS as fixtureActions };\n');
  const mutate = (change: string, path = ['task', 'report']) => cli([], false, `
    import { main, fixtureActions as ACTIONS } from ${JSON.stringify(pathToFileURL(entry).href)};
    ${change}
    await main(${JSON.stringify([...path, '-h'])});
  `);
  const before = cli(['task', 'report']);
  assert.equal(mutate(''), before, 'the private emitted copy preserves ordinary help');
  const changed = mutate("ACTIONS['task.withdraw'].grants = [['user']];");
  assert.notEqual(changed, before);
  assert.match(changed.split('\n').find(line => line.includes('--withdraw <id> (question'))!, /only a person or the coordinator/);
  const held = mutate("delete ACTIONS['task.withdraw'].whileHeld;");
  assert.match(held.split('\n').find(line => line.includes('--withdraw <id> (question'))!, /own Task held: unavailable/);
  const scope = mutate("ACTIONS['task.read'].grants = [['run'], ['user']];", ['task', 'get']);
  assert.notEqual(scope, cli(['task', 'get']));
  assert.doesNotMatch(scope, /a Run in its own project/);
});

test('every act is reachable from help examples or explicitly has no command', () => {
  assert.deepEqual(describedActs().sort(), Object.keys(ACTIONS).sort());
});

test('entry-specific conditions, roles and scopes remain visible in the corresponding help', () => {
  assert.match(cli(['task', 'comment']), /Comment: only a person or the coordinator; or a Run in its own project/);
  assert.match(accessHelp('task.file-put'), /a person.*current placement/);
  assert.doesNotMatch(accessHelp('task.file-put'), /coordinator/);
  assert.match(accessHelp('task.request'), /--agent <member>: only the Task's responsible Run/);
  assert.match(accessHelp('task.request'), /closed; failed user-requested Task; addressed to Task.*no caller/);
  assert.match(accessHelp('task.report'), /manager: return held Task/);
  assert.ok(accessHelp('task.report').includes('--state done (target with an open question to the user)'));
  assert.match(accessHelp('task.report'), /own Task held: unavailable/);
  assert.ok(accessHelp('task.report').includes(reportCallerRules.checkpoint.help));
  assert.ok(accessHelp('task.report').includes(reportCallerRules.askTo.help));
  assert.ok(accessHelp('task.report').includes(urgentRecipient.help));
  assert.ok(accessHelp('task.comment').includes(urgentRecipient.help.replace('--urgent: ', '')));
  assert.ok(accessHelp('coordinator reply.get').includes(replyAccess.help));
  assert.match(accessHelp('operation.get'), /No Task: only a person\./);
  assert.match(accessHelp('server.set'), /outside server authorization/);
  assert.match(accessHelp('deploy'), /own Task held: unavailable/);
  assert.match(accessHelp('config.set'), /only a person or the coordinator\./);
  assert.match(accessHelp('task.new'), /Task here means --parent/);
  assert.match(accessHelp('deploy'), /either key, even empty, claims a Run/);
  assert.equal(accessHelp('task.comment').match(/--urgent:/g)?.length, 1);
});

test('skill routes execution to generated Access instead of another permission table', () => {
  const skill = readFileSync(new URL('../skills/alpacawork/SKILL.md', import.meta.url), 'utf8');
  // Checked by command names, not by the skill's wording, so the skill can be reworded or translated.
  assert.match(skill, /alpacawork <group> <verb> -h.*Access/);
  const coordinator = readFileSync(new URL('../skills/alpacawork/references/coordinator.md', import.meta.url), 'utf8');
  assert.match(coordinator, /task report -h.*task request -h/);
});

test('help owns the cwd rule, the exit codes and the default server; options that rely on the rule say where it is', () => {
  const top = cli([]);
  assert.equal(top.match(/cwd rule:/g)?.length, 1);
  const relying = commandCatalog.commands.flatMap(spec => spec.options).filter(option => option.description.includes('cwd rule'));
  assert.ok(relying.length > 0);
  for (const option of relying) assert.ok(option.description.includes('cwd rule (alpacawork -h)'), option.key);
  const exitCodes = top.split('\n').find(line => line.startsWith('Exit codes:'));
  for (const code of Object.values(CLI_EXIT_CODE)) assert.match(exitCodes!, new RegExp(`\\b${code}\\b`));
  assert.ok(cli(['server']).includes(DEFAULT_SERVER_ORIGIN));
});

test('--from-user help limits the mark to project-level Tasks and directs added results to the responsible', () => {
  for (const command of ['new', 'update'])
    assert.match(cli(['task', command]), /only\s+directly\s+below a project, never a child Task/);
  assert.match(cli(['task', 'new']), /Only the parent Task’s responsible Run creates children/);
  assert.match(cli(['task', 'new']), /task request/);
});
