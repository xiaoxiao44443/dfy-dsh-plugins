// Integration checks against the shipped DSH runtime. No models, user data,
// sockets, or installed profile are used. All sessions live only in memory.
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolTurns } from '../plugins/codex-bridge/lib/tool-turns.js';
import { installNativePromptBridge } from '../plugins/media-blocks/lib/native-prompt.js';

const runtime = process.argv[2] && resolve(process.argv[2]);
if (!runtime) throw new Error('Usage: node scripts/test-runtime-compat.mjs <DSH runtime directory>');
const sdk = (name) => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { Context, Service } = await sdk('cordis');
const { SessionStore, Session } = await sdk('dsh-session');
const { AgentRegistry } = await sdk('dsh-agent');
const { SessionProjectionRegistry } = await sdk('dsh-session-projection');
const { AgentLoop } = await sdk('dsh-agent-loop');
const { ApprovalService } = await sdk('dsh-user-approval');
const { ToolRuntime } = await sdk('dsh-tools');

const ctx = new Context();
new SessionStore(ctx);
new AgentRegistry(ctx);
new SessionProjectionRegistry(ctx);
ctx.provide('llm', { prepareCall() { throw new Error('Integration test must never invoke a model'); } });
ctx.provide('systemPrompt', {
  variable() {}, context() {}, tools() {},
  async assemble() { return { contexts: [], sections: [], variables: {}, tools: [] }; },
});
new ToolRuntime(ctx, { mode: 'native' });
new AgentLoop(ctx, { agents: [], maxParallelToolCalls: 1 });
new ApprovalService(ctx, { policy: 'ask' });
const turns = new ToolTurns(ctx);
const handle = await ctx.agents.create({ sessionId: 'session-compat-fixture', agentOptions: { provider: 'fixture', model: 'fixture' } });
const agent = handle.agent;
try {
  let answer = 'allowed-once';
  let decisions = 0;
  ctx.on('approval/request', async () => { decisions++; return answer === 'wait' ? new Promise(() => {}) : answer; });
  let effects = 0;
  const invoke = () => turns.execute(agent, 'fixture', async signal => {
    const outcome = await ctx.approval.request({ agent, toolName: 'fixture', reason: 'fixture approval', signal });
    if (outcome === 'allowed-once') effects++;
    return outcome;
  }, AbortSignal.timeout(5000));
  assert.equal(await invoke(), 'allowed-once');
  answer = 'rejected';
  assert.equal(await invoke(), 'rejected');
  await agent.whenIdle();
  assert.equal(effects, 1);
  assert.equal(decisions, 2);
  const events = agent.session.snapshotEvents();
  let open = false;
  for (const event of events) {
    if (event.type === 'turn/start') { assert.equal(open, false); open = true; }
    if (event.type === 'approval/asked' || event.type === 'approval/decided') assert.equal(open, true);
    if (event.type === 'turn/end') open = false;
  }
  assert.equal(open, false);
  assert.equal(events.filter(e => e.type === 'approval/asked').length, 2);
  assert.equal(events.filter(e => e.type === 'approval/decided').length, 2);
  assert.equal(events.some(e => e.type === 'request/header' || e.type === 'assistant/message'), false);
  console.log('PASS actual AgentLoop + ApprovalService: allowed/rejected, enclosed audit, no model request');

  const order = [];
  await Promise.all([1, 2, 3].map(i => turns.execute(agent, 'queued', async () => { order.push(i); return i; }, AbortSignal.timeout(5000))));
  assert.deepEqual(order, [1, 2, 3]);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const first = turns.execute(agent, 'hold', async () => { entered.resolve(); await release.promise; return 'done'; }, AbortSignal.timeout(5000));
  await entered.promise;
  const cancelQueued = new AbortController();
  const cancelled = turns.execute(agent, 'cancel-queued', async () => { throw new Error('cancelled request must not execute'); }, cancelQueued.signal);
  const rejected = assert.rejects(cancelled);
  cancelQueued.abort(new Error('fixture cancelled'));
  release.resolve();
  await first; await rejected; await agent.whenIdle();
  assert.equal(agent.inbox.nextTurn.length, 0);
  answer = 'wait';
  const cancelApproval = new AbortController();
  const asked = Promise.withResolvers();
  const stopAsked = ctx.on('session/event', (_session, event) => { if (event.type === 'approval/asked') asked.resolve(); });
  const active = turns.execute(agent, 'cancel-approval', signal => ctx.approval.request({ agent, toolName: 'cancel-approval', signal }), cancelApproval.signal);
  const activeRejected = assert.rejects(active);
  await asked.promise; cancelApproval.abort(new Error('withdraw approval')); await activeRejected;
  await agent.whenIdle(); stopAsked();
  const lastDecision = agent.session.snapshotEvents().filter(e => e.type === 'approval/decided').at(-1);
  assert.equal(lastDecision.data.outcome, 'cancelled');
  console.log('PASS actual AgentLoop: concurrent FIFO, queued cancellation, in-flight approval cancellation');
  const replay = Session.create(agent.id, agent.session.snapshotEvents(), agent.session.header);
  assert.deepEqual(replay.snapshotEvents().slice(0, agent.session.seq), agent.session.snapshotEvents());
  console.log('PASS actual Session replay validator: tool and approval turns form a valid durable log');

  let toolBodies = 0;
  ctx.tools.register({ name: 'integration_fixture', description: 'Fixture', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'number' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async () => ++toolBodies,
  });
  ctx.on('tools/pre-execute', async (execution, next) => execution.name === 'integration_fixture' ? { kind: 'ask', reason: 'fixture permission' } : next());
  answer = 'allowed-once';
  const toolCall = id => turns.execute(agent, 'integration_fixture', signal => ctx.agents.withInitiator(agent, () => ctx.tools.execute({ agent, callId: id, name: 'integration_fixture', arguments: {}, signal })), AbortSignal.timeout(5000));
  assert.equal((await toolCall('fixture-allow')).isError, false);
  answer = 'rejected';
  assert.equal((await toolCall('fixture-deny')).isError, true);
  assert.equal(toolBodies, 1);
  console.log('PASS actual ToolRuntime: original pre-execute policy and approval gate control body execution');

  // Cordis rebinding creates caller proxies; verify install/cleanup against them.
  class Controller extends Service {
    constructor(context) { super(context, 'fixtureController'); }
    async prompt() { return { accepted: true }; }
  }
  new Controller(ctx);
  const controller = ctx.fixtureController;
  const cleanup1 = installNativePromptBridge(controller, {});
  const cleanup2 = installNativePromptBridge(controller, {});
  cleanup1();
  assert.deepEqual(await controller.prompt({ sessionId: 'test', content: [] }, new AbortController().signal), { accepted: true });
  cleanup2();
  assert.equal(Object.hasOwn(controller, 'prompt'), false);
  console.log('PASS actual Cordis service proxy: native prompt install, overlapping reload and cleanup');

  const { SessionCommandController } = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/commands.js')).href);
  const inbox = { nextTurn: [], nextStep: [] };
  const receiver = { id: 'session-upload-fixture', inbox, session: { snapshotEvents: () => [] }, followup: message => inbox.nextTurn.push(message) };
  const selection = { provider: 'fixture', model: 'text-only' };
  const agentController = { resolveAgent: async () => ({ agent: receiver }), selectionFor: () => ({ current: selection }), serializeImageAdmission: (_agent, run) => run() };
  const imageRef = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1 };
  const fileRef = { attachmentId: 'file-fixture', name: 'notes.txt', bytes: 1 };
  let binds = 0;
  const files = { resolve: (_agent, id) => id === 'own-file' ? fileRef : undefined, bindPrompt: () => ({ commit() { binds++; }, [Symbol.dispose]() {} }) };
  const host = { agents: { get: () => receiver }, fileUploads: files,
    llm: { listProviders: () => [{ id: 'fixture' }], resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
    attachments: { admitPromptContent: async parts => parts.map(p => p.type === 'image' ? { type: 'image', attachment: imageRef } : p) },
  };
  const commands = new SessionCommandController(host, agentController, '/tmp');
  const native = { prompt: request => commands.prompt(request), resolveAgent: agentController.resolveAgent };
  const prompt = { sessionId: receiver.id, requestId: 'upload-retry', mode: 'queue', content: [
    { type: 'image', mediaType: 'image/png', data: 'fixture' }, { type: 'file', receiptId: 'own-file' },
  ], clientTimeZone: 'Asia/Shanghai' };
  await assert.rejects(native.prompt(prompt), e => e.details.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES');
  const removeNative = installNativePromptBridge(native, { prepare: async () => true, admit: host.attachments.admitPromptContent, isLive: a => a === receiver, files });
  await Promise.all([native.prompt(prompt, new AbortController().signal), native.prompt(prompt, new AbortController().signal)]);
  assert.equal(inbox.nextTurn.length, 1); assert.equal(binds, 1);
  assert.deepEqual(inbox.nextTurn[0].content.map(p => p.type), ['dfy-media', 'file']);
  await assert.rejects(native.prompt({ ...prompt, requestId: 'bad-timezone', clientTimeZone: 'Not/A_Timezone' }, new AbortController().signal), e => e.code === 'session/invalid-time-zone');
  assert.equal(inbox.nextTurn.length, 1);
  removeNative();
  console.log('PASS official SessionCommandController: text-model image admission, mixed files, idempotency and timezone validation');
} finally {
  turns.dispose();
  await handle.dispose();
}
