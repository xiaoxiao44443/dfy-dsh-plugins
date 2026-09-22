import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('bundle composes every maintained plugin with its original ID exactly once', async () => {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const catalog = JSON.parse(await readFile(new URL('../../catalog.json', root), 'utf8'));
  const members = catalog.plugins.filter(entry => entry.name !== manifest.name).map(entry => entry.name);
  assert.deepEqual(manifest.dfy.includes, members);
  assert.deepEqual(Object.keys(manifest.dependencies), members);
  assert.equal(new Set(members).size, 8);
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8');
  const rows = [...patch.matchAll(/- id: ([\w-]+)\s+name: '([^']+)'/g)];
  assert.deepEqual(rows.map(row => row[2]), members);
  for (const [, id, name] of rows) {
    const slug = name.replace('@dfy-plugins/dsh-', '');
    const standalone = await readFile(new URL(`../${slug}/cordis.patch.yml`, root), 'utf8');
    assert.ok(standalone.includes(`id: ${id}\n`));
    assert.ok(standalone.includes(`name: '${name}'`));
    assert.equal(manifest.dependencies[name], 'workspace:*');
  }
  assert.ok(!members.includes('@dfy-plugins/dsh-vision'));
});
