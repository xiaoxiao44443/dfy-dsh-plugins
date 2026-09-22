import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importLegacySettings, legacySettingsPatch } from '../lib/settings.js';

test('legacy settings import never overwrites profile overrides or unknown fields', () => {
  assert.deepEqual(legacySettingsPatch({ size: 19, enabled: true, unknown: 1 }, { size: 16 }, { size: 14, enabled: false }), { enabled: true });
});

for (const filename of ['settings.yaml', 'settings.yaml.imported']) {
  test(`imports ${filename} once and preserves the original document`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'dfy-config-migration-'));
    const dir = join(home, 'profiles/web');
    const source = 'dsh-appearance:\n  chatFontSize: 19\n  collapseCompletedProcess: true\n';
    const calls = [];
    const ctx = {
      get: () => ({ home, dir }),
      settings: {
        describe: () => [{ ns: 'appearance', value: { chatFontSize: 16, collapseCompletedProcess: false }, user: { chatFontSize: 17 }, revision: 4 }],
        update: async (...args) => { calls.push(args); },
      },
    };
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(home, filename), source);
      await importLegacySettings(ctx, 'appearance', 'dsh-appearance');
      await importLegacySettings(ctx, 'appearance', 'dsh-appearance');
      assert.deepEqual(calls, [['appearance', { collapseCompletedProcess: true }, 4]]);
      assert.equal(await readFile(join(home, filename), 'utf8'), source);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}

test('a failed import remains retryable without a completed marker', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dfy-config-retry-'));
  let fail = true;
  let writes = 0;
  const ctx = {
    get: () => ({ home, dir: home }),
    settings: {
      describe: () => [{ ns: 'appearance', value: { chatFontSize: 16 }, user: {}, revision: 0 }],
      update: async () => { if (fail) throw new Error('write failed'); writes++; },
    },
  };
  try {
    await writeFile(join(home, 'settings.yaml'), 'dsh-appearance:\n  chatFontSize: 19\n');
    await assert.rejects(importLegacySettings(ctx, 'appearance', 'dsh-appearance'), /write failed/);
    fail = false;
    await importLegacySettings(ctx, 'appearance', 'dsh-appearance');
    assert.equal(writes, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});
