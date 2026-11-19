import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

// These administrative entry points cannot return their Problems to a running screen.
const cliOnly = new Set([
  'apps/backend/src/control/initialize.ts', 'apps/backend/src/workspace.ts',
  'packages/core/src/platform/index.ts', 'apps/backend/src/installation/public-setup.ts', 'apps/backend/src/installation/uninstall.ts',
  // cli/entries -> deployNode or CLI-only public-setup -> deploy -> deploy-source.
  'apps/backend/src/installation/deploy-entry.ts', 'apps/backend/src/installation/deploy.ts',
  'apps/backend/src/release/deploy-source.ts',
  'apps/backend/src/release/build.ts', 'apps/backend/src/release/entries.ts', 'apps/backend/src/release/layout.ts',
  'apps/backend/src/release/switch.ts', 'apps/backend/src/release/maintenance-process.ts',
]);
// restoreChanged already names the common restore refusal and has a complete translated next step.
// These dedicated public codes already express the complete source refusal, including status where needed.
const completeCodes = new Set(['attachmentRequestReplaced', 'urgentToUser', 'questionClosed', 'questionExpired',
  'questionStopped', 'restoreChanged', 'voiceTooLarge', 'voiceEmpty', 'voiceRecognitionFailed']);

// Only this top-level function is CLI-only; absolutePath in the same module is shared.
const cliOnlyFunctions = new Map([
  ['apps/backend/src/installation/files.ts', new Set(['assertProductDirectory'])],
]);
function cliOnlyFunction(file: string, node: ts.Node) {
  return ts.isFunctionDeclaration(node) && ts.isSourceFile(node.parent) && !!node.name &&
    !!cliOnlyFunctions.get(file)?.has(node.name.text);
}
function missingProblemReasons(file: string, text: string) {
  if (cliOnly.has(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const missing: string[] = [];
  const visit = (node: ts.Node) => {
    if (cliOnlyFunction(file, node)) return;
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'Problem') {
      const args = node.arguments ?? [];
      const code = args[0]?.getText(source).replace('PROBLEM_CODE.', '');
      const options = args[3];
      const reason = options && ts.isObjectLiteralExpression(options) && options.properties.some(property =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText(source) === 'reason');
      if (!reason && !completeCodes.has(code ?? '')) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        missing.push(`${file}:${line}: ${args[1]?.getText(source)}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return missing;
}

test('every production Problem has an explicit reason unless its complete code or CLI-only boundary owns the text', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps/backend/src', 'packages/core/src', 'packages/db/src',
    'packages/raw/src', 'packages/runs/src'], { encoding: 'utf8' }).trim().split('\n').filter(file => file.endsWith('.ts') && existsSync(file));
  const missing = files.flatMap(file => missingProblemReasons(file, readFileSync(file, 'utf8')));
  assert.deepEqual(missing, []);
});

test('side errors keep reasons when copying a Problem code, message and path', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'apps/backend/src', 'packages/core/src'], { encoding: 'utf8' })
    .trim().split('\n').filter(file => file.endsWith('.ts') && existsSync(file));
  const missing: string[] = [];
  for (const file of files) {
    if (cliOnly.has(file)) continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (cliOnlyFunction(file, node)) return;
      if (ts.isObjectLiteralExpression(node)) {
        const properties = node.properties.filter(ts.isPropertyAssignment);
        const named = (name: string) => properties.find(property => property.name.getText(source) === name);
        const code = named('code')?.initializer;
        const problemCode = code && ts.isPropertyAccessExpression(code) &&
          (code.expression.getText(source) === 'PROBLEM_CODE' || code.name.text === 'code');
        if (problemCode && named('message') && named('path')) {
          let reason = false;
          const find = (part: ts.Node) => {
            if ((ts.isPropertyAssignment(part) || ts.isShorthandPropertyAssignment(part)) && part.name.getText(source) === 'reason') reason = true;
            ts.forEachChild(part, find);
          };
          find(node);
          if (!reason) missing.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(missing, []);
});

test('CLI classification does not exempt shared functions, nested names or the same name in a public module', () => {
  const text = `
    export function assertProductDirectory() { throw new Problem(PROBLEM_CODE.unsafePath, 'cli'); }
    export function absolutePath() { throw new Problem(PROBLEM_CODE.invalidInput, 'shared'); }
    export function publicHandler() { function assertProductDirectory() { throw new Problem(PROBLEM_CODE.invalidInput, 'nested'); } }
  `;
  const missing = missingProblemReasons('apps/backend/src/installation/files.ts', text);
  assert.equal(missing.length, 2);
  assert.match(missing.join('\n'), /'shared'/);
  assert.match(missing.join('\n'), /'nested'/);
  assert.equal(missingProblemReasons('apps/backend/src/raw/storage.ts', text).length, 3);
  assert.deepEqual(missingProblemReasons('apps/backend/src/installation/public-setup.ts', text), []);
});
