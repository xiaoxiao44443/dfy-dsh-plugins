// Exercise official DSH installation from archives or npm in a disposable home.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.argv[2] && resolve(process.argv[2]);
const fromRegistry = process.argv.includes('--registry');
assert.ok(runtime && process.argv.slice(3).every(arg => arg === '--registry'), 'Usage: pnpm release:test-install <DSH runtime directory containing node_modules> [--registry]');
const runtimeRequire = createRequire(createRequire(join(runtime, 'package.json')).resolve('@deepseek-ai/dsh/package.json'));
const artifacts = JSON.parse(await readFile(join(root, 'release/npm/manifest.json'), 'utf8'));
const plugins = artifacts.filter(pkg => pkg.name.startsWith('@dfy-plugins/dsh-'));
const bundle = plugins.find(pkg => pkg.name === '@dfy-plugins/dsh-bundle');
assert.ok(bundle, 'The release must include the DFY composition package');
const members = plugins.filter(pkg => pkg !== bundle);
for (const mode of ['individual', 'bundle']) {
const direct = mode === 'bundle' ? [bundle] : members;
const home = await mkdtemp(join(tmpdir(), 'dfy-npm-install-'));
try {
  const launcher = join(home, 'dsh.mjs');
  const entry = join(dirname(runtimeRequire.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
  await writeFile(launcher, `process.argv[1] = ${JSON.stringify(entry)}; const cli = await import(${JSON.stringify(pathToFileURL(entry).href)}); if (typeof cli.runCli === 'function') await cli.runCli();\n`);
  const env = { ...process.env, DSH_HOME: home, npm_config_update_notifier: 'false' };
  const run = (args, stdio = 'pipe') => execFileSync(process.execPath, ['--expose-internals', launcher, ...args], {
    cwd: home, env, stdio, encoding: 'utf8', timeout: 120_000,
  });
  run(['plugin', '--profile', 'web', 'list', '--depth', '0']);
  const profile = join(home, 'profiles/web');
  // The public libraries are not on npm before the first release. Override only
  // our internal packages with the very same archives being installed directly.
  if (!fromRegistry) {
    const configPath = join(profile, 'pnpm-workspace.yaml');
    await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n${[
      'overrides:',
      ...artifacts.map(pkg => `  ${JSON.stringify(pkg.name)}: ${JSON.stringify(`file:${join(root, 'release/npm', pkg.filename)}`)}`),
      '',
    ].join('\n')}`);
  }
  run(['plugin', '--profile', 'web', 'add', '--ignore-scripts', '--config.verify-deps-before-run=false',
    '--registry', 'https://registry.npmjs.org',
    ...direct.map(pkg => fromRegistry ? `${pkg.name}@${pkg.version}` : join(root, 'release/npm', pkg.filename))], 'inherit');
  const installed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.deepEqual(installed.dsh.profile.bundles.filter(name => name.startsWith('@dfy-plugins/')).sort(), direct.map(pkg => pkg.name).sort());
  const dump = run(['--profile', 'web', '--dump-config']);
  for (const pkg of members) {
    assert.ok(dump.includes(pkg.name), `Missing composed plugin: ${pkg.name}`);
    assert.equal(dump.split(pkg.name).length - 1, 1, `Duplicate composed plugin: ${pkg.name}`);
  }

  // Import from the installed profile with DSH's current package resolution service.
  // No plugin apply(), server, model or real user profile is invoked.
  const smoke = join(home, 'imports.mjs');
  await writeFile(smoke, `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { realpath } from 'node:fs/promises';
    import { pathToFileURL } from 'node:url';
    const { loadProfile, createRuntimeResolution, PluginPackages } = await import(${JSON.stringify(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-app-boot')).href)});
    const installAnchor = ${JSON.stringify(runtimeRequire.resolve('@deepseek-ai/dsh/package.json'))};
    const home = ${JSON.stringify(home)};
    const profile = loadProfile('dsh', 'web', installAnchor, home);
    const { Context } = await import(${JSON.stringify(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href)});
    const ctx = new Context();
    await ctx.plugin(PluginPackages, { resolution: await createRuntimeResolution({ installAnchor, profile, home }) });
    try {
    const require = createRequire(${JSON.stringify(join(profile, 'package.json'))});
    for (const pkg of ${JSON.stringify(artifacts.filter(pkg => mode === 'bundle' || pkg !== bundle))}) {
      const entry = await realpath(require.resolve(pkg.name));
      assert.ok(entry.startsWith(${JSON.stringify(`${await realpath(home)}${sep}`)}), 'Package resolved outside disposable installation: ' + entry);
      const loaded = await import(pathToFileURL(entry).href);
      if (pkg.name.startsWith('@dfy-plugins/dsh-') && pkg.name !== '@dfy-plugins/dsh-bundle') assert.equal(typeof (loaded.apply ?? loaded.default), 'function', 'Missing plugin entry: ' + pkg.name);
      console.log('Imported installed package: ' + pkg.name);
    }
    } finally { await ctx.fiber.dispose(); }
  `);
  execFileSync(process.execPath, ['--expose-internals', smoke], { cwd: home, env, stdio: 'inherit', timeout: 60_000 });
  run(['plugin', '--profile', 'web', 'remove', '--config.ignore-scripts=true', '--config.verify-deps-before-run=false', ...direct.map(pkg => pkg.name)]);
  const removed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.ok(removed.dsh.profile.bundles.every(name => !name.startsWith('@dfy-plugins/')));
  console.log(`Verified ${mode} install from ${fromRegistry ? 'npm' : 'archives'}, unique composition, module imports and removal`);
} finally {
  await rm(home, { recursive: true, force: true });
}
}
