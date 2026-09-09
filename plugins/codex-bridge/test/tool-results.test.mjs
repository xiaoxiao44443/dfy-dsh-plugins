import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';

test('bridge preserves structured results across legacy and PTC child call ids', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-results-'));
  const discovery = join(root, 'bridge.json');
  process.env.DSH_CODEX_BRIDGE_FILE = discovery;
  const { apply } = await import('../lib/index.js');
  const events = new Map();
  const emit = (name, ...args) => { for (const listener of events.get(name) ?? []) listener(...args); };
  const log = [];
  let turn = 0;
  let idle = Promise.resolve();
  let cleanup;
  let childSpelling = 'code';
  const agent = { id: 'session-fixture', status: 'idle', inbox: { nextTurn: [], nextStep: [] },
    session: { header: { createdAt: 1, cwd: root }, snapshotEvents: () => [...log], get seq() { return log.length; } },
    whenIdle: () => idle,
    followup(message) {
      agent.status = 'running';
      idle = Promise.resolve().then(async () => {
        const current = ++turn;
        const append = (type, data) => { const event = { type, data, seq: log.length, time: 1 }; log.push(event); emit('session/event', agent.session, event); };
        append('turn/start', { turn: current });
        let next = async () => ({ kind: 'enter', messages: [message] });
        for (const listener of [...events.get('agent/pre-step')].reverse()) { const tail = next; next = () => listener({ agent, messages: [message], turn: current, step: 1, signal: new AbortController().signal }, tail); }
        assert.deepEqual((await next()).messages, []);
        append('turn/end', { turn: current, reason: { kind: 'completed' } });
        agent.status = 'idle';
      });
    },
  };
  const expected = { value: { answer: 42 }, content: [{ type: 'image', attachment: { id: 'fixture-image' } }] };
  const ctx = {
    agents: { list: () => [agent], withInitiator: (_agent, run) => run() },
    on: (name, handler) => { const listeners = events.get(name) ?? []; listeners.push(handler); events.set(name, listeners); },
    tools: {
      schemas: () => [{ name: 'fixture_tool' }, { name: 'run_code', description: 'TypeScript program' }],
      async execute(call) {
        assert.equal(call.name, 'run_code');
        assert.equal(call.agent, agent);
        // Another call tree and an unrelated nested tool must not steal the result.
        emit('tools/result', { callId: 'other:ptc:1', rootCallId: 'other', name: 'fixture_tool' }, { wrong: true });
        emit('tools/result', { callId: `${call.callId}:${childSpelling}:1`, rootCallId: call.callId, name: 'fixture_tool' }, expected);
        emit('tools/result', { callId: `${call.callId}:${childSpelling}:2`, rootCallId: call.callId, name: 'unrelated' }, { wrong: true });
        return { value: 'outer textual wrapper' };
      },
    },
    settings: { register: () => ({ get: () => ({ enabled: true }), watch: () => {} }) },
    webServer: { register() {} },
    effect: (setup) => { cleanup = setup(); },
  };
  t.after(async () => {
    cleanup?.();
    delete process.env.DSH_CODEX_BRIDGE_FILE;
    // stopBridge closes asynchronously and removes only its own discovery file.
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await readFile(discovery); } catch { break; }
      await setTimeout(10);
    }
    await rm(root, { recursive: true, force: true });
  });
  apply(ctx);
  let endpoint;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { endpoint = JSON.parse(await readFile(discovery, 'utf8')); break; } catch { await setTimeout(10); }
  }
  assert.ok(endpoint, 'bridge should publish its temporary endpoint');
  for (const spelling of ['code', 'ptc', 'future-child-format']) {
    childSpelling = spelling;
    const response = await fetch(`${endpoint.origin}/v1/rpc`, {
      method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'tools.call', params: { name: 'fixture_tool', arguments: {}, sessionId: agent.id } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).result, expected);
  }
});
