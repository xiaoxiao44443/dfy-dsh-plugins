import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RunTracker,
  createRunMessage,
  deterministicMessageId,
  messageIdFromRunId,
  runIdForMessageId,
} from '../lib/runs.js';

function fakeAgent(id = 'session-test') {
  const events = [];
  const session = {
    events,
    get seq() { return events.length },
    header: { id, createdAt: 100, cwd: 'C:\\workspace' },
  };
  return {
    id,
    status: 'idle',
    session,
    inbox: { nextTurn: [], nextStep: [] },
    options: {},
  };
}

function append(agent, type, data, time = 1_000) {
  const event = { seq: agent.session.events.length, time, type, data };
  agent.session.events.push(event);
  return event;
}

test('snapshot-only sessions support history, resumed run lookup and completed output', () => {
  const agent = fakeAgent();
  const message = createRunMessage('read newer session', agent.id, 'snapshot-fixture');
  append(agent, 'turn/start', { turn: 1 });
  append(agent, 'user/message', message);
  append(agent, 'assistant/message', {
    turn: 1, step: 1,
    message: { id: 'assistant-fixture', role: 'assistant', content: [{ type: 'text', text: 'restored output' }] },
  });
  append(agent, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  const events = agent.session.events;
  delete agent.session.events;
  agent.session.snapshotEvents = () => Object.freeze([...events]);
  const tracker = new RunTracker(() => [agent]);
  const history = tracker.readMessages(agent, 0, 20);
  assert.ok(history.events.some((event) => event.role === 'assistant'));
  const run = tracker.snapshot(runIdForMessageId(message.id));
  assert.equal(run.status, 'completed');
  assert.equal(run.latestText, 'restored output');
});

test('idempotency keys produce stable session-scoped message and reversible run ids', () => {
  const first = String(deterministicMessageId('session-a', 'request-1'));
  assert.equal(first, String(deterministicMessageId('session-a', 'request-1')));
  assert.notEqual(first, String(deterministicMessageId('session-b', 'request-1')));
  const runId = runIdForMessageId(first);
  assert.equal(messageIdFromRunId(runId), first);
  assert.equal(messageIdFromRunId('not-a-run'), undefined);
});

test('run tracking correlates one message to its turn and returns incremental output and tools', () => {
  const agent = fakeAgent();
  const tracker = new RunTracker(() => [agent]);
  const message = createRunMessage('do the work', String(agent.id), 'request-1');
  agent.inbox.nextTurn.push(message);
  const queued = tracker.register(agent, message, 'queue', agent.session.seq, 'request-1');
  assert.equal(queued.status, 'queued');

  const start = append(agent, 'turn/start', { turn: 7 });
  tracker.onSessionEvent(agent, start);
  agent.inbox.nextTurn.length = 0;
  tracker.onClaimed(agent, message, 7);
  const user = append(agent, 'user/message', message);
  tracker.onSessionEvent(agent, user);
  const chunk = append(agent, 'assistant/chunk', {
    turn: 7,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: 'done' },
  });
  tracker.onSessionEvent(agent, chunk);
  const call = append(agent, 'tool/call', {
    turn: 7,
    step: 1,
    callId: 'call-1',
    name: 'browser_execute',
    arguments: '{"code":"return 1"}',
  });
  tracker.onSessionEvent(agent, call);
  const result = append(agent, 'tool/result', {
    turn: 7,
    step: 1,
    message: {
      id: 'message-result',
      role: 'user',
      source: { kind: 'tool', callId: 'call-1' },
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'ok' }],
      }],
    },
  });
  tracker.onSessionEvent(agent, result);
  const end = append(agent, 'turn/end', { turn: 7, reason: { kind: 'completed' } });
  tracker.onSessionEvent(agent, end);

  const completed = tracker.snapshot(queued.runId, queued.cursor);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.terminal, true);
  assert.equal(completed.turn, 7);
  assert.equal(completed.latestText, 'done');
  assert.equal(completed.textDelta, 'done');
  assert.deepEqual(completed.toolCalls.map(({ name, status, resultText }) => ({ name, status, resultText })), [{
    name: 'browser_execute',
    status: 'completed',
    resultText: 'ok',
  }]);
  assert.ok(completed.events.some((event) => event.type === 'tool_call' && event.name === 'browser_execute'));
  assert.ok(completed.events.some((event) => event.type === 'tool_result' && event.text === 'ok'));
  assert.deepEqual(completed.completion, { kind: 'completed' });
});

test('wait returns heartbeat only when a nonterminal run has not changed', async () => {
  const agent = fakeAgent();
  const tracker = new RunTracker(() => [agent]);
  const message = createRunMessage('later', String(agent.id));
  agent.inbox.nextTurn.push(message);
  const queued = tracker.register(agent, message, 'queue', 0);
  const waited = await tracker.wait(queued.runId, queued.cursor, 5);
  assert.equal(waited.status, 'queued');
  assert.equal(waited.changed, false);
  assert.equal(waited.heartbeat, true);
});

test('wait wakes as soon as a correlated run event changes the cursor', async () => {
  const agent = fakeAgent();
  const tracker = new RunTracker(() => [agent]);
  const message = createRunMessage('wake me', String(agent.id));
  agent.inbox.nextTurn.push(message);
  const queued = tracker.register(agent, message, 'queue', 0);
  const waiting = tracker.wait(queued.runId, queued.cursor, 1_000);
  tracker.onClaimed(agent, message, 9);
  const changed = await waiting;
  assert.equal(changed.changed, true);
  assert.equal(changed.heartbeat, false);
  assert.equal(changed.status, 'running');
  assert.equal(changed.turn, 9);
});

test('queued cancellation is terminal and leaves other inbox messages untouched', () => {
  const agent = fakeAgent();
  const tracker = new RunTracker(() => [agent]);
  const target = createRunMessage('cancel me', String(agent.id));
  const other = createRunMessage('keep me', String(agent.id));
  agent.inbox.nextTurn.push(target, other);
  const run = tracker.register(agent, target, 'queue', 0);
  agent.inbox.nextTurn.splice(0, 1);
  tracker.markQueuedCancelled(run.runId);
  const cancelled = tracker.snapshot(run.runId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.terminal, true);
  assert.deepEqual(agent.inbox.nextTurn, [other]);
});

test('a fresh tracker recovers a completed run from the durable session log', () => {
  const agent = fakeAgent();
  const message = createRunMessage('recover', String(agent.id), 'recover-1');
  append(agent, 'turn/start', { turn: 3 });
  append(agent, 'user/message', message);
  append(agent, 'assistant/chunk', {
    turn: 3,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: 'restored' },
  });
  append(agent, 'turn/end', { turn: 3, reason: { kind: 'completed' } });
  const tracker = new RunTracker(() => [agent]);
  const recovered = tracker.snapshot(runIdForMessageId(String(message.id)));
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.latestText, 'restored');
  assert.equal(recovered.turn, 3);
});

test('message reads paginate with a lossless numeric cursor', () => {
  const agent = fakeAgent();
  const first = createRunMessage('one', String(agent.id));
  const second = createRunMessage('two', String(agent.id));
  append(agent, 'turn/start', { turn: 1 });
  append(agent, 'user/message', first);
  append(agent, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  append(agent, 'turn/start', { turn: 2 });
  append(agent, 'user/message', second);
  append(agent, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  const tracker = new RunTracker(() => [agent]);
  const page1 = tracker.readMessages(agent, 0, 2);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.events.length, 2);
  const page2 = tracker.readMessages(agent, page1.cursor, 10);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.events.length, 4);
  assert.equal(page2.cursor, agent.session.seq);
});
