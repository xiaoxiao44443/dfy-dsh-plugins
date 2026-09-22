import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { apply } from '../lib/index.js';

test('tool publishes HTML and assets beneath the current session directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-visualize-'));
  const sessionDir = join(root, 'workspace', 'session-11111111-1111-4111-8111-111111111111');
  const files = new Map([
    ['view.html', new TextEncoder().encode('<!doctype html><body><img src="assets/chart.png"></body>')],
    ['chart.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47])],
  ]);
  let tool;
  let skill;
  let route;
  const ctx = {
    tools: { register(value) { tool = value; return () => {}; } },
    skills: { register(value) { skill = value; return () => {}; } },
    sessionPersistence: {
      locate() { return { kind: 'jsonl', path: join(sessionDir, 'session.jsonl.zstd') }; },
      async list() { return []; },
    },
    fs: {
      async resolve(path) { return { path, displayPath: path }; },
      async stat(target) {
        const data = files.get(target.displayPath);
        return data === undefined ? undefined : { type: 'file', size: data.byteLength, version: 'v1' };
      },
      async readBytes(target) { return files.get(target.displayPath); },
    },
    emit() {},
    inject(_dependencies, callback) {
      callback({ effect: setup => setup(), webServer: { register(value) { route = value; return () => {}; } } });
    },
    effect(setup) { setup(); },
  };
  try {
    apply(ctx);
    assert.equal(skill.name, 'dfy-visualize');
    assert.equal(route.kind, 'prefix');
    const value = await tool.execute({
      file_path: 'view.html',
      title: '图表',
      asset_paths: ['chart.png'],
    }, {
      signal: new AbortController().signal,
      agent: {
        id: 'session-11111111-1111-4111-8111-111111111111',
        session: { header: { cwd: root } },
      },
    });
    const artifactDir = join(sessionDir, 'artifacts', 'visualizations', value.artifactId);
    const [html, manifest, asset] = await Promise.all([
      readFile(join(artifactDir, 'index.html'), 'utf8'),
      readFile(join(artifactDir, 'manifest.json'), 'utf8'),
      readFile(join(artifactDir, 'assets', 'chart.png')),
    ]);
    assert.match(html, /data-dsh-visualize-bridge/);
    assert.equal(JSON.parse(manifest).sessionId, value.sessionId);
    assert.deepEqual([...asset], [0x89, 0x50, 0x4e, 0x47]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

