import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';

test('plugin manager opens bridge settings with the live entry configuration', async () => {
  const require = createRequire(import.meta.url);
  const built = await build({
    entryPoints: [fileURLToPath(new URL('../src/client.tsx', import.meta.url))],
    bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
    external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  });
  const module = { exports: {} };
  runInNewContext(built.outputFiles[0].text, {
    module, exports: module.exports,
    require: id => id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : require(id),
  });
  const entries = [], scope = {};
  module.exports.apply({
    effect() {},
    configForms: { get(entryId) { assert.equal(entryId, 'codex-bridge'); return scope; } },
    slots: { inject(_name, register) { register(); }, register(options, component) { entries.push({ options, component }); } },
  });
  for (const [name, key] of [['plugins.bundle.config', '@dfy-plugins/dsh-codex-bridge'], ['plugins.row.config', '@dfy-plugins/dsh-bundle#codex-bridge']]) {
    const view = entries.find(item => item.options.name === name && item.options.key === key);
    assert.ok(view, key);
    assert.equal(typeof view.component({ view: 'summary' }), 'string');
    assert.equal(view.component({ view: 'page' }).props.scope, scope);
  }
});
