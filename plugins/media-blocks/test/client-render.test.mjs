import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const built = await build({
  entryPoints: [new URL('../src/client.tsx', import.meta.url).pathname],
  bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-connection/client', '@deepseek-ai/dsh-client-ui-primitives'],
});
const source = built.outputFiles[0].text;
const attachment = {
  attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 12, width: 1, height: 1, name: '截图.png',
};
const media = { type: 'dfy-media', version: 1, resource: { kind: 'image', ref: 'test-ref', attachment } };
const text = { type: 'text', text: '看看这张图片' };

function render(content, generation) {
  const module = { exports: {} };
  const primitives = {
    IconCheckOutline16: () => null, IconCopyOutline16: () => null,
    JsonBlock: ({ payload }) => React.createElement('pre', { 'data-extra-block': true }, JSON.stringify(payload)),
    Tooltip: ({ children }) => children,
    writeClipboard: async () => true,
    ...(generation === 'current'
      ? { projectUserText: (value, references, skills) => {
        assert.deepEqual(Array.from(references), []);
        assert.deepEqual(Array.from(skills), []);
        return React.createElement('span', { 'data-current-text': true }, value);
      } }
      : { MessageText: ({ text }) => React.createElement('span', { 'data-legacy-text': true }, text) }),
  };
  runInNewContext(source, {
    module, exports: module.exports,
    require(id) {
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
      if (id === '@deepseek-ai/dsh-client-connection/client') return { RpcId: value => value };
      return require(id);
    },
  });
  const entries = [];
  module.exports.apply({
    effect() {}, connection: {},
    slots: { inject(_name, callback) { callback(); }, register(options, component) { entries.push({ options, component }); } },
  });
  assert.equal(entries.some(entry => entry.options.name === 'conversation.input.left'), false);
  const entry = entries.find(entry => entry.options.key === 'user');
  return renderToStaticMarkup(React.createElement(entry.component, {
    node: { seq: 1, data: { time: 1, content } },
    loadImage: async () => 'data:image/png;base64,fixture', t: key => key,
  }));
}

for (const generation of ['legacy', 'current']) {
  test(`${generation} client renders historical media and text without an extra-content block`, () => {
    const html = render([text, media], generation);
    assert.match(html, /dsh-media-gallery/);
    assert.match(html, /截图.png/);
    assert.match(html, /看看这张图片/);
    assert.match(html, new RegExp(`data-${generation}-text`));
    assert.doesNotMatch(html, /data-extra-block/);
  });
}

test('current client renders uploaded images and files together with text', () => {
  const html = render([text, { type: 'image', attachment }, { type: 'file', attachment: {
    attachmentId: 'file-fixture', name: '说明.pdf', bytes: 2048,
  } }], 'current');
  assert.match(html, /dsh-media-gallery/);
  assert.match(html, /dsh-media-file-card/);
  assert.match(html, /说明.pdf/);
  assert.match(html, /2 KB/);
  assert.doesNotMatch(html, /data-extra-block/);
});

test('unknown or malformed content remains visible instead of being silently removed', () => {
  const html = render([{ type: 'future-block', value: 'retained' }, { type: 'file', attachment: null }], 'current');
  assert.match(html, /data-extra-block/);
  assert.match(html, /retained/);
});
