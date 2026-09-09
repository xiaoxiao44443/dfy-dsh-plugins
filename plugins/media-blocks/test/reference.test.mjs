import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { markAgentLoopRequest } from '@deepseek-ai/dsh-llm';

import MediaBlocks, {
  decodeMediaImageRef,
  detectImageMediaType,
  encodeMediaImageRef,
  transformMediaContent,
  mediaAdapterOptions,
} from '../lib/index.js';

const attachment = {
  attachmentId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  mediaType: 'image/png',
  bytes: 42,
  width: 100,
  height: 80,
  name: '截图.png',
};

const mediaBlock = {
  type: 'dfy-media',
  version: 1,
  resource: { kind: 'image', ref: encodeMediaImageRef(attachment), attachment },
  presentation: { name: attachment.name },
};

const options = {
  provider: 'test',
  model: 'test',
  messages: [],
};

test('PTC media adapters see only the initiating agent catalog without changing provider wire tools', () => {
  const agent = {};
  const wire = markAgentLoopRequest({ ...options, tools: [{ name: 'run_code' }] });
  const ctx = { agents: { currentInitiator: () => agent }, get: () => ({ schemas(scope) {
    assert.equal(scope, agent);
    return [{ name: 'run_code' }, { name: 'dfy_vision_analyze' }];
  } }) };
  const adapted = mediaAdapterOptions(wire, ctx);
  assert.ok(adapted.tools.some(tool => tool.name === 'dfy_vision_analyze'));
  assert.deepEqual(wire.tools, [{ name: 'run_code' }]);
  const oneShot = { ...wire, purpose: 'vision' };
  assert.equal(mediaAdapterOptions(oneShot, ctx), oneShot);
  const restricted = mediaAdapterOptions(wire, { ...ctx, get: () => ({ schemas: () => [{ name: 'run_code' }] }) });
  assert.equal(restricted.tools.some(tool => tool.name === 'dfy_vision_analyze'), false);
});

test('image references round-trip official attachment metadata', () => {
  assert.deepEqual(decodeMediaImageRef(encodeMediaImageRef(attachment)), attachment);
  assert.throws(() => decodeMediaImageRef('not-a-reference'), /reference is invalid/);
});

test('supported raster media types are detected from container signatures', () => {
  assert.equal(detectImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(detectImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff])), 'image/jpeg');
  assert.equal(detectImageMediaType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'image/gif');
  assert.equal(detectImageMediaType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp');
  assert.equal(detectImageMediaType(Uint8Array.from([0, 1, 2, 3])), undefined);
});

test('image-capable requests materialize an official image block', () => {
  const projected = transformMediaContent([mediaBlock], true, options, new Map());
  assert.equal(projected.changed, true);
  assert.deepEqual(projected.content, [{ type: 'image', attachment }]);
});

test('text requests use the registered reference adapter without changing durable media', () => {
  const adapters = new Map([['image', ({ block }) => [{
    type: 'text',
    text: `<vision_image ref="${block.resource.ref}" />`,
  }]]]);
  const projected = transformMediaContent([mediaBlock], false, options, adapters);
  assert.equal(projected.changed, true);
  assert.match(projected.content[0].text, /^<vision_image ref=/);
  assert.equal(mediaBlock.type, 'dfy-media');
});

test('multiple adapters can share one media kind and the first applicable result wins', () => {
  const adapters = new Map([['image', [
    { adapter: () => undefined },
    { adapter: ({ supportsImages }) => [{ type: 'text', text: supportsImages ? '<image_ref />' : '<edit_ref />' }] },
  ]]])
  const textProjected = transformMediaContent([mediaBlock], false, options, adapters)
  assert.deepEqual(textProjected.content, [{ type: 'text', text: '<edit_ref />' }])

  const imageProjected = transformMediaContent([mediaBlock], true, options, adapters)
  assert.equal(imageProjected.content[0].type, 'image')
  assert.deepEqual(imageProjected.content[1], { type: 'text', text: '<image_ref />' })
})

test('reference adapters registered from an injected child fiber reach the Host instance', async () => {
  const ctx = new Context();
  const host = new MediaBlocks(ctx);
  let proxiedStatus;
  let disposeAdapter;
  let ready = false;
  let prepareCalls = 0;
  const dependent = ctx.inject(['mediaBlocks'], (child) => {
    disposeAdapter = child.mediaBlocks.registerReferenceAdapter('image', () => [], {
      prepare: async () => {
        prepareCalls += 1;
        return ready;
      },
    });
    proxiedStatus = child.mediaBlocks.status();
  });
  await dependent;
  assert.equal(host.hasReferenceAdapter('image'), true);
  assert.equal(await host.prepareReferenceAdapter('image'), false);
  ready = true;
  assert.equal(await host.prepareReferenceAdapter('image'), true);
  assert.equal(prepareCalls, 2);
  assert.deepEqual(host.status(), proxiedStatus);
  disposeAdapter();
  assert.equal(host.hasReferenceAdapter('image'), false);
  assert.equal(await host.prepareReferenceAdapter('image'), false);
  dependent.dispose();
});

test('same-kind adapter preparers remain independently disposable', async () => {
  const ctx = new Context()
  const host = new MediaBlocks(ctx)
  let disposeFirst = () => {}
  let disposeSecond = () => {}
  const dependent = ctx.inject(['mediaBlocks'], (child) => {
    disposeFirst = child.mediaBlocks.registerReferenceAdapter('image', () => undefined, { prepare: () => false })
    disposeSecond = child.mediaBlocks.registerReferenceAdapter('image', () => [], { prepare: () => true })
  })
  await dependent
  assert.equal(host.hasReferenceAdapter('image'), true)
  assert.equal(await host.prepareReferenceAdapter('image'), true)
  disposeFirst()
  assert.equal(host.hasReferenceAdapter('image'), true)
  assert.equal(await host.prepareReferenceAdapter('image'), true)
  disposeSecond()
  assert.equal(host.hasReferenceAdapter('image'), false)
  dependent.dispose()
})
