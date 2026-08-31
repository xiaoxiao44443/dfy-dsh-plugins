import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pluginRoot = new URL('../', import.meta.url);

test('image generation keeps package, Cordis, API, settings, Tool and Skill ids separate', async () => {
  const [pkg, patch, host, client] = await Promise.all([
    readFile(new URL('package.json', pluginRoot), 'utf8'),
    readFile(new URL('cordis.patch.yml', pluginRoot), 'utf8'),
    readFile(new URL('src/index.ts', pluginRoot), 'utf8'),
    readFile(new URL('src/client.tsx', pluginRoot), 'utf8'),
  ]);

  const manifest = JSON.parse(pkg);
  assert.equal(manifest.name, '@dfy-plugins/dsh-image-generation');
  assert.equal(manifest.dependencies?.['@dfy-plugins/dsh-media-blocks'], undefined);
  assert.equal(manifest.peerDependenciesMeta?.['@dfy-plugins/dsh-media-blocks']?.optional, true);
  assert.match(patch, /id: image-generation\r?\n\s+name: '@dfy-plugins\/dsh-image-generation'/);
  assert.match(host, /'dsh-image-generation' as SettingsNamespace/);
  assert.match(host, /baseUrl: z\.string\(\)\.default\(''\)/);
  assert.match(host, /model: z\.string\(\)\.default\(''\)/);
  assert.doesNotMatch(host, /apiKeyEnv/);
  assert.match(host, /credentialRef\('DFY_IMAGE_GENERATION_API_KEY'\)/);
  assert.match(host, /ctx\.credentials\.set\(IMAGE_API_KEY_REF, apiKey\.trim\(\)\)/);
  assert.match(host, /ctx\.on\('credentials\/reference-updated', \(ref\) =>/);
  assert.doesNotMatch(host, /credentials\/updated/);
  assert.match(host, /'\/api\/dsh-image-generation\/status'/);
  assert.match(host, /'\/api\/dsh-image-generation\/resource'/);
  assert.match(host, /'dfy-session-image'/);
  assert.match(host, /publishSessionImages/);
  assert.match(host, /sessionPersistence/);
  assert.match(host, /ctx\.attachments\.validateImage\(image\)/);
  assert.doesNotMatch(host, /ctx\.attachments\.saveImages\(/);
  assert.match(host, /'dfy_image_generate'/);
  assert.match(host, /'dfy-image-generation'/);
  assert.match(client, /DFY IMAGE GENERATE/);
  assert.match(client, /dfy-session-image/);
  assert.match(client, /data-dsh-image-output=\{images\.length === 0 \? undefined : ''\}/);
  assert.match(client, /data-dsh-artifact-content="image"/);
  assert.match(client, /'\/api\/dsh-image-generation\/resource'/);
  assert.doesNotMatch(client, /dsh-media-blocks\/resource/);
  assert.match(client, /type="password"/);
  assert.match(client, /已配置 —— 输入新值可替换/);
  assert.match(client, /ctx\.effect\(installStyles, 'dsh-image-generation: client styles'\)/);
  assert.match(client, /existing\.replaceWith\(tag\)/);
  assert.doesNotMatch(client, /<style>\{STYLES\}<\/style>/);
});
