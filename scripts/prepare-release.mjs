// Build first, then inspect the exact archives that will be published.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'release', 'npm');
const pnpm = process.env.npm_execpath;
assert.ok(pnpm?.includes('pnpm'), 'Run this script with pnpm release:prepare');
const ts = createRequire(join(root, 'plugins/media-blocks/package.json'))('typescript');
const packages = new Map();
for (const group of ['packages', 'plugins']) {
  for (const entry of await readdir(join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = `${group}/${entry.name}`;
    const manifest = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'));
    if (manifest.private) continue;
    assert.ok(manifest.name.startsWith('@dfy-plugins/'));
    assert.equal(manifest.publishConfig?.access, 'public');
    assert.equal(manifest.repository?.url, 'git+https://github.com/xiaoxiao44443/dfy-dsh-plugins.git');
    packages.set(manifest.name, { directory, manifest });
  }
}
// Publish libraries and internal peers before the plugins that use them.
const ordered = [];
const visiting = new Set();
const visited = new Set();
function visit(name) {
  if (visited.has(name)) return;
  assert.ok(!visiting.has(name), `Circular release dependency: ${name}`);
  visiting.add(name);
  const pkg = packages.get(name);
  for (const dependency of Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.peerDependencies })) {
    if (packages.has(dependency)) visit(dependency);
  }
  visiting.delete(name);
  visited.add(name);
  ordered.push(pkg);
}
for (const name of packages.keys()) visit(name);

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected archive symlink: ${path}`);
    result.push(...entry.isDirectory() ? await files(path) : [path]);
  }
  return result;
}
function targets(value) {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];
}
await mkdir(output, { recursive: true });
await rm(join(output, 'manifest.json'), { force: true });
const scratch = await mkdtemp(join(tmpdir(), 'dfy-npm-pack-'));
const artifacts = [];
try {
  for (const { directory, manifest: source } of ordered) {
    execFileSync(process.execPath, [pnpm, '--config.verify-deps-before-run=false', 'pack', '--pack-destination', output], {
      cwd: join(root, directory), stdio: ['ignore', 'pipe', 'inherit'],
    });
    const filename = `${source.name.slice(1).replace('/', '-')}-${source.version}.tgz`;
    const archive = join(output, filename);
    const unpack = join(scratch, source.name.split('/')[1]);
    await mkdir(unpack);
    execFileSync('tar', ['-xzf', archive, '-C', unpack], { env: { ...process.env, LC_ALL: 'C' } });
    const packageRoot = join(unpack, 'package');
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.name, source.name);
    assert.equal(manifest.version, source.version);
    assert.ok(!JSON.stringify({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies }).includes('workspace:'), `${source.name}: unpublished workspace dependency`);
    for (const [name, range] of Object.entries(source.dependencies ?? {})) {
      if (range !== 'workspace:^') continue;
      assert.equal(manifest.dependencies[name], `^${packages.get(name).manifest.version}`, `${source.name}: incorrect packed version for ${name}`);
    }
    for (const path of [manifest.main, manifest.types, manifest.dsh?.bundle?.patch, ...targets(manifest.exports)].filter(Boolean)) {
      const absolute = resolve(packageRoot, path);
      assert.ok(absolute.startsWith(`${packageRoot}${sep}`), `${source.name}: export outside package: ${path}`);
      assert.ok((await stat(absolute)).isFile(), `${source.name}: missing export: ${path}`);
    }
    assert.ok((await stat(join(packageRoot, 'README.md'))).isFile());
    assert.ok((await stat(join(packageRoot, 'LICENSE'))).isFile());
    for (const file of await files(packageRoot)) {
      const path = relative(packageRoot, file).split(sep).join('/');
      assert.ok(!/(^|\/)(node_modules|src|test|tests|\.git|\.env[^/]*|\.DS_Store)(\/|$)/.test(path), `Unexpected published file: ${path}`);
      if (!path.endsWith('.js') || path === 'lib/client.js' || !path.startsWith('lib/')) continue;
      const tree = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const node of tree.statements) {
        if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || !node.moduleSpecifier) continue;
        const specifier = node.moduleSpecifier.text;
        if (specifier.startsWith('.')) {
          assert.ok((await stat(resolve(dirname(file), specifier))).isFile(), `${source.name}: missing relative module ${specifier}`);
        } else if (!isBuiltin(specifier)) {
          const dependency = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
          assert.ok(dependency in { ...manifest.dependencies, ...manifest.peerDependencies }, `${source.name}: undeclared import ${specifier}`);
        }
      }
    }
    if (manifest.dsh?.client) {
      const registrations = [];
      runInNewContext(await readFile(join(packageRoot, 'lib/client.js'), 'utf8'), {
        window: { __ModuleLoader__: { load: entry => registrations.push(entry) } },
      }, { timeout: 1000 });
      assert.equal(registrations.length, 1);
      assert.equal(registrations[0].id, source.name);
      assert.equal(typeof registrations[0].factory, 'function');
    }
    const integrity = `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`;
    artifacts.push({ name: source.name, version: source.version, filename, integrity });
    console.log(`Checked ${source.name}@${source.version}`);
  }
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(artifacts, null, 2)}\n`);
  console.log(`Prepared ${artifacts.length} verified packages in ${output}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
