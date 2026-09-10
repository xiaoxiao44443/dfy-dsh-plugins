// Publish the previously checked archives, with npm CLI for OIDC support.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = 'https://registry.npmjs.org/';
const publish = process.argv.includes('--publish');
assert.ok(process.argv.slice(2).every(arg => arg === '--publish'), 'Only --publish is supported; omit it for a dry run');
const artifacts = JSON.parse(await readFile(join(root, 'release/npm/manifest.json'), 'utf8'));
assert.ok(Array.isArray(artifacts) && artifacts.length > 0, 'Run pnpm release:prepare first');
const pending = [];
// Finish the whole preflight before uploading any package.
for (const artifact of artifacts) {
  assert.equal(basename(artifact.filename), artifact.filename);
  const path = join(root, 'release/npm', artifact.filename);
  const integrity = `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`;
  assert.equal(integrity, artifact.integrity, `Archive changed since validation: ${artifact.name}`);
  const response = await fetch(`${registry}${encodeURIComponent(artifact.name)}/${encodeURIComponent(artifact.version)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) pending.push(path);
  else {
    assert.ok(response.ok, `Registry returned ${response.status} for ${artifact.name}`);
    const published = await response.json();
    assert.equal(published.dist?.integrity, integrity, `${artifact.name}@${artifact.version} already exists with different contents; bump its version`);
    console.log(`Already published: ${artifact.name}@${artifact.version}`);
  }
}
for (const path of pending) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'publish', path, '--access', 'public', '--registry', registry, ...(publish ? [] : ['--dry-run']),
  ], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `npm publish failed: ${basename(path)}`);
}
console.log(`${publish ? 'Published' : 'Dry run completed for'} ${pending.length} packages`);
