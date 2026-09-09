import assert from 'node:assert/strict';
import test from 'node:test';
import { installNativePromptBridge } from '../lib/native-prompt.js';

const image = { type: 'image', data: 'fixture', mediaType: 'image/png' };
const attachment = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 };
const unsupported = Object.assign(new Error('unsupported'), { code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } });
function fixture() {
  const accepted = new Map();
  const deliveries = [];
  const bindings = [];
  const agent = { id: 'session-a', followup: (m) => { deliveries.push(['queue', m]); accepted.set(m.source.rpcId, m); }, steer: (m) => { deliveries.push(['steer', m]); accepted.set(m.source.rpcId, m); } };
  const controller = {
    async prompt(request) {
      assert.equal(this, controller);
      if (accepted.has(request.requestId)) return { accepted: true };
      if (request.content.some(part => part.type === 'image')) throw unsupported;
      return { accepted: true };
    },
    async resolveAgent() { return { agent }; },
  };
  const deps = {
    prepare: async () => true, isLive: (a) => a === agent,
    admit: async parts => parts.map(part => part.type === 'image' ? { type: 'image', attachment } : part),
    files: {
      resolve: (_agent, receipt) => receipt === 'owned' ? { name: 'a.pdf', attachmentId: 'file', bytes: 1 } : undefined,
      bindPrompt(_agent, receipts, requestId) {
        const item = { receipts, requestId, committed: false, disposed: false }; bindings.push(item);
        return { commit() { item.committed = true; }, [Symbol.dispose]() { item.disposed = true; } };
      },
    },
  };
  const request = { requestId: 'r1', sessionId: agent.id, mode: 'queue', content: [image], clientTimeZone: 'Asia/Shanghai' };
  return { controller, deps, request, agent, deliveries, bindings };
}
const signal = () => new AbortController().signal;

test('native image fallback preserves mixed files, steering, time zone and retry identity', async () => {
  const f = fixture(); installNativePromptBridge(f.controller, f.deps);
  const request = { ...f.request, mode: 'steer', content: [{ type: 'text', text: 'look' }, image, { type: 'file', receiptId: 'owned' }] };
  await Promise.all([f.controller.prompt(request, signal()), f.controller.prompt(request, signal())]);
  assert.equal(f.deliveries.length, 1);
  const [mode, message] = f.deliveries[0];
  assert.equal(mode, 'steer'); assert.equal(message.source.rpcId, 'r1'); assert.equal(message.source.clientTimeZone, 'Asia/Shanghai');
  assert.deepEqual(message.content.map(p => p.type), ['text', 'dfy-media', 'file']);
  assert.deepEqual(f.bindings, [{ receipts: ['owned'], requestId: 'r1', committed: true, disposed: true }]);
});

test('disabled routes and unrelated official errors remain rejected', async () => {
  const f = fixture(); f.deps.prepare = async () => false; installNativePromptBridge(f.controller, f.deps);
  await assert.rejects(f.controller.prompt(f.request, signal()), e => e === unsupported);
  assert.equal(f.deliveries.length, 0);
  const denied = Object.assign(new Error('not found'), { code: 'session/not-found' });
  const g = fixture(); g.controller.prompt = async () => { throw denied; }; installNativePromptBridge(g.controller, g.deps);
  await assert.rejects(g.controller.prompt(g.request, signal()), e => e === denied);
});

test('foreign receipts and invalid image bytes do not enqueue or bind a prompt', async () => {
  const f = fixture(); installNativePromptBridge(f.controller, f.deps);
  await assert.rejects(f.controller.prompt({ ...f.request, content: [image, { type: 'file', receiptId: 'foreign' }] }, signal()), e => e.details.reason === 'FILE_NOT_STAGED');
  f.deps.admit = async () => { throw Object.assign(new Error('bad PNG'), { code: 'INVALID_IMAGE' }); };
  await assert.rejects(f.controller.prompt(f.request, signal()), e => e.details.reason === 'INVALID_IMAGE');
  assert.equal(f.deliveries.length, 0); assert.equal(f.bindings.length, 0);
});

test('cancellation and session replacement before admission do not deliver', async () => {
  for (const kind of ['cancel', 'replacement']) {
    const f = fixture(); const abort = new AbortController();
    f.deps.admit = async () => { if (kind === 'cancel') abort.abort(new Error('cancelled')); else f.deps.isLive = () => false; return [{ type: 'image', attachment }]; };
    installNativePromptBridge(f.controller, f.deps);
    await assert.rejects(f.controller.prompt(f.request, abort.signal));
    assert.equal(f.deliveries.length, 0);
  }
});

test('failed delivery rolls file bindings back, and overlapping reload cleanup preserves the new wrapper', async () => {
  const f = fixture(); const original = f.controller.prompt;
  const old = installNativePromptBridge(f.controller, f.deps);
  const current = installNativePromptBridge(f.controller, f.deps);
  old();
  f.agent.followup = () => { throw new Error('delivery failed'); };
  await assert.rejects(f.controller.prompt(f.request, signal()), /delivery failed/);
  assert.equal(f.bindings[0].committed, false); assert.equal(f.bindings[0].disposed, true);
  current(); assert.equal(f.controller.prompt, original);
});

test('image-capable official prompts pass through without preparing or storing plugin media', async () => {
  const f = fixture(); f.controller.prompt = async () => ({ accepted: true });
  f.deps.prepare = async () => { throw new Error('must not use fallback'); };
  installNativePromptBridge(f.controller, f.deps);
  assert.deepEqual(await f.controller.prompt(f.request, signal()), { accepted: true });
  assert.equal(f.bindings.length, 0); assert.equal(f.deliveries.length, 0);
});
