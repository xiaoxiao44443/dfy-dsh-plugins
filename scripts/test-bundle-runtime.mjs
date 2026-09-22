// Integration acceptance in a disposable DSH_HOME; never invokes a model.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'Usage: node scripts/test-bundle-runtime.mjs <DSH runtime> [--keep-home]');
const require = createRequire(createRequire(join(runtime, 'package.json')).resolve('@deepseek-ai/dsh/package.json'));
const bundle = JSON.parse(await readFile(join(root, 'plugins/bundle/package.json'), 'utf8'));
const members = bundle.dfy.includes;
const home = await mkdtemp(join(tmpdir(), 'dfy-bundle-runtime-'));
const keep = process.argv.includes('--keep-home');
const profile = join(home, 'profiles/web');
const manifestPath = join(profile, 'package.json');
const patchPath = join(profile, 'cordis.patch.yml');
const entry = join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
const launcher = join(home, 'dsh.mjs');
const env = { ...process.env, DSH_HOME: home, DSH_CODEX_BRIDGE_FILE: join(home, 'bridge.json'), DSH_TELEMETRY: '0',
  PATH: `${join(runtime, 'node_modules/.bin')}${delimiter}${process.env.PATH}` };
const run = args => execFileSync(process.execPath, ['--expose-internals', launcher, ...args], {
  cwd: home, env, windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
});
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
let succeeded = false;
try {
  await writeFile(launcher, `process.argv[1] = ${JSON.stringify(entry)}; const cli = await import(${JSON.stringify(pathToFileURL(entry).href)}); await cli.runCli();\n`);
  run(['plugin', '--profile', 'web', 'add', '--ignore-scripts', ...members.map(name =>
    `link:${join(root, 'plugins', name.replace('@dfy-plugins/dsh-', ''))}`)]);
  const before = JSON.parse(await readFile(manifestPath, 'utf8'));
  before.dsh.profile.bundles = before.dsh.profile.bundles.filter(name => name !== '@dfy-plugins/dsh-turn-guard');
  await writeJson(manifestPath, before);
  // One bundle switch and one per-entry switch, plus custom values and data.
  const patch = [{ id: 'appearance', config: { chatFontSize: 19 }, disabled: true },
    { id: 'codex-bridge', config: { enabled: false } }];
  await writeJson(patchPath, patch);
  const dataPath = join(home, 'storages/dfy-plugins/wallpaper/fixture.txt');
  await mkdir(dirname(dataPath), { recursive: true });
  await writeFile(dataPath, 'preserved wallpaper data');

  // Follow the documented offline migration, carrying bundle disables to rows.
  const disabled = members.filter(name => !before.dsh.profile.bundles.includes(name));
  run(['plugin', '--profile', 'web', 'remove', '--config.ignore-scripts=true', ...members]);
  assert.deepEqual(JSON.parse(await readFile(patchPath, 'utf8')), patch);
  for (const name of disabled) patch.push({ id: name.replace('@dfy-plugins/dsh-', ''), disabled: true });
  await writeJson(patchPath, patch);
  run(['plugin', '--profile', 'web', 'add', '--ignore-scripts', `link:${join(root, 'plugins/bundle')}`]);
  const after = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(after.dependencies).filter(name => members.includes(name)), []);
  assert.deepEqual(after.dsh.profile.bundles.filter(name => name.startsWith('@dfy-plugins/')), [bundle.name]);
  assert.equal(await readFile(dataPath, 'utf8'), 'preserved wallpaper data');
  console.log('PASS offline standalone-to-bundle migration: original patch, data and disabled choices retained');

  const probe = join(home, 'probe.mjs');
  await writeFile(probe, `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    export const inject = ['pluginManager', 'appReady', 'settings'];
    export function apply(ctx) {
      ctx.effect(() => ctx.appReady.onReady(() => setImmediate(async () => {
        const watchdog = setTimeout(() => { console.error('Lifecycle check timed out'); process.exit(1); }, 30000);
        try {
          const names = ${JSON.stringify(members)};
          const rows = () => ctx.pluginManager.listPlugins();
          const initial = await rows();
          for (const name of names) {
            const matches = initial.filter(row => row.moduleName === name);
            assert.equal(matches.length, 1, name + ': not exactly one entry');
            assert.equal(matches[0].enabled, !['@dfy-plugins/dsh-appearance', '@dfy-plugins/dsh-turn-guard'].includes(name));
            assert.equal(matches[0].readOnlyReason, undefined);
          }
          assert.ok(ctx.get('hmr'), 'Expected HMR for live lifecycle verification');
          for (const name of names) {
            const row = (await rows()).find(row => row.moduleName === name);
            for (const enabled of [true, false, row.enabled]) {
              const result = await ctx.pluginManager.setPluginEnabled(row.entryId, enabled);
              assert.equal(result.application, 'applied', JSON.stringify(result));
              const current = (await rows()).find(item => item.moduleName === name);
              assert.equal(current.enabled, enabled);
              assert.equal(current.error, undefined);
              if (name === '@dfy-plugins/dsh-appearance' && enabled) {
                assert.equal(ctx.settings.describe().find(item => item.ns === 'appearance').value.chatFontSize, 19);
              }
            }
          }
          for (const enabled of [false, true]) {
            const result = await ctx.pluginManager.setBundleEnabled(${JSON.stringify(bundle.name)}, enabled);
            assert.equal(result.application, 'applied', JSON.stringify(result));
            assert.equal((await rows()).filter(row => names.includes(row.moduleName)).length, enabled ? 8 : 0);
          }
          const final = await rows();
          for (const name of ['@dfy-plugins/dsh-appearance', '@dfy-plugins/dsh-turn-guard']) {
            assert.equal(final.find(row => row.moduleName === name).enabled, false);
          }
          assert.equal(readFileSync(${JSON.stringify(dataPath)}, 'utf8'), 'preserved wallpaper data');
          console.log('PASS real DSH bundle boot: eight unique entries, per-entry live switches, whole-bundle restart and preserved settings');
          clearTimeout(watchdog);
          await ctx.root.fiber.dispose();
          process.exit(0);
        } catch (error) { console.error(error); clearTimeout(watchdog); process.exit(1); }
      })));
    }
  `);
  const overlay = join(home, 'probe.patch.json');
  await writeJson(overlay, [{ insert: [{ id: 'bundle-acceptance', name: pathToFileURL(probe).href }] }]);
  const output = run(['web', '--patch', overlay, '--no-open', '--port', '0']);
  assert.ok(output.includes('PASS real DSH bundle boot'), output);
  console.log(output.split('\n').filter(line => line.includes('PASS ')).join('\n'));
  succeeded = true;
} catch (error) {
  if (error.stdout) console.error(String(error.stdout));
  if (error.stderr) console.error(String(error.stderr));
  throw error;
} finally {
  if (keep && succeeded) console.log(`Fixture retained for UI acceptance: ${home}`);
  else await rm(home, { recursive: true, force: true });
}
