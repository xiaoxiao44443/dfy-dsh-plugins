import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { persistedSessionArtifactDirectory, sessionArtifactDirectory } from '../lib/session-storage.js';

const header = { id: 'session-fixture', cwd: resolve('workspace') };
const directory = resolve('sessions', header.id);
const signal = new AbortController().signal;

test('legacy persisted resources resolve by header after the agent is unloaded', async () => {
  const backend = {
    async list(received) { assert.equal(received, signal); return [header]; },
    locate(received) { assert.equal(received, header); return { path: join(directory, 'session.jsonl.zstd') }; },
  };
  assert.equal(await persistedSessionArtifactDirectory(backend, header.id, signal), directory);
  assert.equal(await persistedSessionArtifactDirectory(backend, 'missing', signal), undefined);
});

test('handle-based persistence resolves snapshots without opening or migrating sessions', async () => {
  const backend = {
    async stat(id, options) { assert.equal(options.signal, signal); return id === header.id ? { header, revision: 'r3' } : undefined; },
    list() { throw new Error('should not enumerate every session'); },
    open() { throw new Error('must not open or migrate a session to serve an artifact'); },
    locate(received) { assert.equal(received, header); return { path: join(directory, 'session.v3.jsonl.zstd') }; },
  };
  assert.equal(await persistedSessionArtifactDirectory(backend, header.id, signal), directory);
  assert.equal(await persistedSessionArtifactDirectory(backend, 'missing', signal), undefined);
  assert.equal(sessionArtifactDirectory(backend, header), directory);
});

test('list snapshots, cancellation and backends without disk locations are handled', async () => {
  const backend = {
    async list() { return [{ header, revision: 'r3' }]; },
    locate() { return { path: join(directory, 'session.v3.jsonl') }; },
  };
  assert.equal(await persistedSessionArtifactDirectory(backend, header.id, signal), directory);
  assert.equal(sessionArtifactDirectory({}, header), undefined);
  assert.equal(sessionArtifactDirectory({ locate: () => ({ path: 'relative.jsonl' }) }, header), undefined);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(persistedSessionArtifactDirectory(backend, header.id, controller.signal), /cancelled/);
});
