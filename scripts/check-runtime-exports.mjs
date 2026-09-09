// Check the JavaScript actually shipped by DSH, including frontend-only modules
// that cannot be checked by compiling against the older development SDK.
// This checks named imports, not service behavior, slot props, CSS, or UI flows.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.argv[2] && resolve(process.argv[2]);
if (!runtime) throw new Error('Usage: node scripts/check-runtime-exports.mjs <DSH runtime directory containing node_modules>');
const ts = createRequire(join(root, 'plugins/media-blocks/package.json'))('typescript');
const sdk = join(runtime, 'node_modules/@deepseek-ai');
const version = JSON.parse(readFileSync(join(sdk, 'dsh/package.json'), 'utf8')).version;
const cache = new Map();
function parse(file) {
  if (!cache.has(file)) cache.set(file, ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true));
  return cache.get(file);
}
function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}
function propertyName(node) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
}
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}

// The frontend loader registers these module namespaces in its built-in map.
// Resolve that map and the exported object with an AST, without executing UI JS.
const bundled = new Map();
const assets = join(sdk, 'dsh-web-frontend/dist/assets');
for (const file of readdirSync(assets).filter((name) => name.endsWith('.js'))) {
  const source = readFileSync(join(assets, file), 'utf8');
  if (!source.includes('"@deepseek-ai/dsh-client-ui-primitives"')) continue;
  const tree = parse(join(assets, file));
  const variables = new Map();
  const namespaces = new Map();
  visit(tree, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) variables.set(node.name.text, node.initializer);
    if (!ts.isPropertyAssignment(node) || !ts.isStringLiteral(node.name)) return;
    if (node.name.text.startsWith('@deepseek-ai/') && ts.isIdentifier(node.initializer)) {
      namespaces.set(node.name.text, node.initializer.text);
    }
  });
  for (const [name, variable] of namespaces) {
    const init = variables.get(variable);
    if (!init) continue;
    let exports;
    visit(init, (node) => {
      if (exports || !ts.isObjectLiteralExpression(node)) return;
      exports = new Set(node.properties.map((p) => propertyName(p.name)).filter(Boolean));
    });
    if (exports?.size) bundled.set(name, exports);
  }
}
if (!bundled.has('@deepseek-ai/dsh-client-ui-primitives')) {
  throw new Error('Cannot identify the actual frontend module exports; update the audit parser for this build.');
}

function runtimeEntry(specifier) {
  const parts = specifier.split('/');
  const pkgDir = join(sdk, parts[1]);
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  let target = manifest.exports?.[parts.length === 2 ? '.' : `./${parts.slice(2).join('/')}`];
  if (parts.length === 2 && !target) target = manifest.main;
  while (target && typeof target === 'object') target = target.import ?? target.default ?? target.node;
  if (typeof target !== 'string') throw new Error(`Cannot locate runtime export: ${specifier}`);
  return resolve(pkgDir, target);
}
const exportCache = new Map();
function moduleExports(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  const names = new Set();
  exportCache.set(file, names);
  // Feature client packages use a ModuleLoader CommonJS factory.
  visit(parse(file), (node) => {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const left = node.left;
    if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === 'exports') {
      names.add(left.name.text);
    }
  });
  for (const node of parse(file).statements) {
    if (ts.isExportDeclaration(node)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const entry of node.exportClause.elements) names.add(entry.name.text);
      } else if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const spec = node.moduleSpecifier.text;
        const target = spec.startsWith('.') ? resolve(dirname(file), spec) : runtimeEntry(spec);
        for (const name of moduleExports(target)) names.add(name);
      }
    }
    if (ts.isExportAssignment(node)) names.add('default');
    if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (node.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) names.add('default');
    else if (node.name) names.add(propertyName(node.name));
    else if (ts.isVariableStatement(node)) for (const decl of node.declarationList.declarations) names.add(propertyName(decl.name));
  }
  return names;
}

let failures = 0;
let total = 0;
for (const group of ['packages', 'plugins']) {
  for (const entry of readdirSync(join(root, group), { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    let checked = 0;
    let namespaces = 0;
    for (const file of files(join(root, group, entry.name, 'src')).filter((file) => /\.tsx?$/.test(file))) {
      for (const node of parse(file).statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        const specifier = node.moduleSpecifier.text;
        const clause = node.importClause;
        if (!specifier.startsWith('@deepseek-ai/') || !clause || clause.isTypeOnly) continue;
        const required = clause.name ? ['default'] : [];
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const item of clause.namedBindings.elements) if (!item.isTypeOnly) required.push((item.propertyName ?? item.name).text);
        } else if (clause.namedBindings) namespaces++;
        try {
          const available = bundled.get(specifier) ?? moduleExports(runtimeEntry(specifier));
          for (const name of required) {
            checked++;
            if (available.has(name)) continue;
            failures++;
            console.error(`MISSING ${relative(root, file)}: ${specifier}.${name}`);
          }
        } catch (error) {
          failures++;
          console.error(`UNVERIFIED ${relative(root, file)}: ${error.message}`);
        }
      }
    }
    total += checked;
    console.log(`${group}/${entry.name}: checked ${checked} named imports${namespaces ? `; ${namespaces} namespace import(s) need capability/behavior checks` : ''}`);
  }
}
console.log(`DSH ${version}: ${total} named imports checked, ${failures} missing/unverified. This is not a full compatibility certification.`);
process.exitCode = failures ? 1 : 0;
