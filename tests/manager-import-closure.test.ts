/** Follow actual runtime imports, including exports, instead of grepping a manager for retired symbol names. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
function imports(source: string): { specifier: string; commonjs: boolean }[] {
  const file = ts.createSourceFile('runtime.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), result: { specifier: string; commonjs: boolean }[] = [];
  const walk = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push({ specifier: node.moduleSpecifier.text, commonjs: false });
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) result.push({ specifier: node.arguments[0].text, commonjs: ts.isIdentifier(node.expression) });
    ts.forEachChild(node, walk);
  };
  walk(file); return result;
}
function resolveImport(specifier: string, from: string, commonjs: boolean): string {
  if (commonjs) return createRequire(from).resolve(specifier);
  const url = import.meta.resolve(specifier, pathToFileURL(from).href);
  return url.startsWith('file:') ? fileURLToPath(url) : url;
}
function audit(entry: string, substitute?: (path: string, text: string) => string) {
  const seen = new Set<string>(), forbidden: string[] = [], builtins = new Set<string>();
  const walk = (path: string) => {
    if (seen.has(path)) return; seen.add(path);
    if (/\/(db|runs)\/dist\//.test(path) && !path.includes('/backend/dist/runs/')) forbidden.push(path);
    if (/\/(agents-settings|config|credentials|scheduler|return-router)\.js$/.test(path)) forbidden.push(path);
    if (!/\.[cm]?js$/.test(path)) return;
    let source = readFileSync(path, 'utf8'); if (substitute) source = substitute(path, source);
    for (const { specifier, commonjs } of imports(source)) {
      if (specifier.startsWith('node:')) { builtins.add(specifier); if (specifier === 'node:sqlite') forbidden.push(specifier); continue; }
      let target: string;
      try { target = resolveImport(specifier, path, commonjs); } catch (error) {
        // koffi's native loader lists optional binaries for every host. Other missing imports remain audit errors.
        if (specifier.startsWith('@koromix/koffi-') && ['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      if (!target.startsWith('/')) { builtins.add(target); if (target === 'sqlite') forbidden.push(target); continue; }
      walk(target);
    }
  };
  walk(entry); return { seen, forbidden, builtins };
}
test('manager runtime import closure contains no DB, settings, key, next-start or reply authority', () => {
  // Node's parent-aware ESM resolver needs this flag. Keep resolution in Node itself,
  // including wildcard/conditional exports, realpaths and the separate require rules.
  const flag = '--experimental-import-meta-resolve';
  if (!process.execArgv.includes(flag)) {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [flag, '--test', '--test-reporter=tap', import.meta.filename], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.status, 0, child.error?.message ?? child.stdout + child.stderr);
    assert.match(child.stdout, /^# tests 1$/m, 'the child must execute the audit, not merely exit successfully');
    assert.match(child.stdout, /^# skipped 0$/m);
    return;
  }
  // Source module paths retain the authority boundaries; emitted chunks retain the shipped import closure.
  // Bundling changes the file count, so traversal is proved by reaching the indirect file owner and detecting a fault there.
  for (const output of ['test-dist', 'dist']) {
    const entry = resolve(`apps/backend/${output}/run-manager.js`), result = audit(entry);
    assert.deepEqual(result.forbidden, [], output);
    let targets = 0;
    const broken = audit(entry, (_path, source) => {
      if (!source.includes('function openRunFile(')) return source;
      targets++;
      return source + "\nimport 'node:sqlite';\n";
    });
    assert.equal(targets, 1, `${output}: the indirect file owner was traversed exactly once`);
    assert.ok(broken.forbidden.includes('node:sqlite'), `${output}: an indirect reintroduced DB import must fail the same audit`);
  }
});
