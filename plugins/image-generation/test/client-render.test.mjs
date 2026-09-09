import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const built = await build({
  entryPoints: [fileURLToPath(new URL('../src/client.tsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
});
const module = { exports: {} };
runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports, TextEncoder, btoa,
  require(id) {
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {
      IconChevronDownOutline14: () => null, IconInspectOutline12: () => null,
      IconSparkle16: () => null, Menu: () => null, StateDot: () => null,
    };
    return require(id);
  },
});
const entries = [];
module.exports.apply({
  effect() {}, settingsScope: { bind() { return {}; } },
  slots: { inject(_name, callback) { callback(); }, register(options, component) { entries.push({ options, component }); } },
});
const entry = entries.find(item => item.options.key === 'dfy_image_generate');
const image = {
  kind: 'dsh-session-image', version: 1, sessionId: 'session-fixture', imageId: 'a'.repeat(64),
  mediaType: 'image/png', bytes: 123, width: 1024, height: 1536, name: '立绘.png',
};
const ref = Buffer.from(JSON.stringify(image)).toString('base64url');
const sessionBlock = { type: 'dfy-session-image', version: 1, ref, image };
const attachment = {
  attachmentId: `sha256:${'b'.repeat(64)}`, mediaType: 'image/png', bytes: 100,
  width: 100, height: 200, name: '旧图.png',
};
const text = [{ type: 'text', text: '<image_generation_result operation="generate">\n'
  + `  <generated_image image_ref="${ref}" name="立绘.png" />\n</image_generation_result>` }];
const settled = {
  kind: 'tool-result', seq: 24, time: 1, callId: 'call-image',
  call: { name: 'dfy_image_generate', argsRaw: '{"prompt":"画一张立绘"}' },
  callTime: 1, content: text, isError: false, subCalls: [],
};

function render(block) {
  return renderToStaticMarkup(React.createElement(entry.component, { block }));
}

test('0.1.5 result metadata shows images without resultView or expanding tool details', () => {
  const html = render({ ...settled, meta: { images: [{ ref, image }] } });
  assert.match(html, /data-dsh-image-output=""/);
  assert.match(html, /data-dsh-artifact-content="image"/);
  assert.match(html, /aria-label="立绘.png"/);
  assert.match(html, /正在加载图片/);
  assert.doesNotMatch(html, /<pre|image_generation_result/);
});

test('legacy resultView preserves session images and official attachment previews', () => {
  const html = render({ ...settled, resultView: {
    card: 'generic', content: [sessionBlock, { type: 'image', attachment }],
  } });
  assert.match(html, /aria-label="立绘.png"/);
  assert.match(html, /aria-label="旧图.png"/);
  assert.equal((html.match(/class="dsh-imagegen-thumb"/g) ?? []).length, 2);
});

test('metadata and old presentation do not produce duplicate galleries', () => {
  const second = { ...image, imageId: 'c'.repeat(64), name: '第二张.png' };
  const secondRef = Buffer.from(JSON.stringify(second)).toString('base64url');
  const html = render({ ...settled, meta: { images: [{ ref, image }, { ref: secondRef, image: second }] },
    resultView: { card: 'generic', content: [sessionBlock] } });
  assert.equal((html.match(/class="dsh-imagegen-thumb"/g) ?? []).length, 2);
  assert.ok(html.indexOf('aria-label="立绘.png"') < html.indexOf('aria-label="第二张.png"'));
});

test('PTC nested results without presentation metadata use the committed image envelope', () => {
  const html = render({ ...settled, parentCallId: 'call-run-code' });
  assert.match(html, /aria-label="立绘.png"/);
  assert.match(html, /data-dsh-artifact-content="image"/);
});

test('legacy attachment metadata and direct image content remain displayable', () => {
  for (const source of [
    { meta: { images: [{ ref: 'legacy-ref', attachment }] } },
    { content: [{ type: 'image', attachment }] },
  ]) assert.match(render({ ...settled, ...source }), /aria-label="旧图.png"/);
});

test('running, failed and malformed results cannot display stale or invalid images', () => {
  for (const block of [
    { argsRaw: '{}', meta: { images: [{ ref, image }] } },
    { ...settled, isError: true, meta: { images: [{ ref, image }] }, resultView: { card: 'generic', content: [sessionBlock] } },
    { ...settled, content: [], meta: { images: [null, {}, { ref: 123, image }, { ref, image: {} }] } },
    { ...settled, content: [], meta: { images: 'invalid' }, resultView: { card: 'generic', content: [{ type: 'image', attachment: {} }] } },
    { ...settled, content: [{ type: 'text', text: `quoted: <generated_image image_ref="${ref}" />` }] },
  ]) assert.doesNotMatch(render(block), /data-dsh-image-output|dsh-imagegen-tool-gallery/);
});
