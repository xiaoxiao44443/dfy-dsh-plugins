import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pluginRoot = new URL('../', import.meta.url);

test('media blocks keeps package, Cordis, API and content ids intentionally separate', async () => {
  const [pkg, patch, host, client] = await Promise.all([
    readFile(new URL('package.json', pluginRoot), 'utf8'),
    readFile(new URL('cordis.patch.yml', pluginRoot), 'utf8'),
    readFile(new URL('src/index.ts', pluginRoot), 'utf8'),
    readFile(new URL('src/client.tsx', pluginRoot), 'utf8'),
  ]);

  assert.equal(JSON.parse(pkg).name, '@dfy-plugins/dsh-media-blocks');
  assert.match(patch, /id: media-blocks\r?\n\s+name: '@dfy-plugins\/dsh-media-blocks'/);
  assert.match(host, /MEDIA_BLOCK_TYPE = 'dfy-media'/);
  assert.match(host, /MEDIA_PROMPT_API = '\/api\/dsh-media-blocks\/prompt'/);
  assert.match(host, /message: `Model "\$\{payload\.selection\.model\}" does not support image input\.`/);
  assert.match(host, /details: \{ reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' \}/);
  assert.doesNotMatch(host, /VISION_ROUTE_UNAVAILABLE/);
  assert.match(client, /export const name = 'media-blocks'/);
  assert.match(client, /ctx\.effect\(installStyles, 'dsh-media-blocks: client styles'\)/);
  assert.match(client, /existing\.replaceWith\(tag\)/);
  assert.doesNotMatch(client, /<style>\{STYLES\}<\/style>/);
  assert.match(client, /\.dsh-media-input/);
  assert.match(client, /@container \(width <= 540px\)/);
  assert.match(client, /conversation\.input\.left/);
  assert.match(client, /conversation\.input\.plan/);
  assert.match(client, /connection: \{ api\?: LegacyApiClient \}/);
  assert.match(client, /if \(api === undefined\) return \(\) => \{\};/);
  assert.match(client, /> div:has\(> div > \[data-slot="conversation\.input\.left"\] \.dsh-media-input\)/);
  assert.doesNotMatch(client, /ResizeObserver/);
  assert.match(client, /locale: 'conversation'/);
});
