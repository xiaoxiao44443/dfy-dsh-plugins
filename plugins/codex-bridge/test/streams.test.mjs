import assert from 'node:assert/strict';
import test from 'node:test';
import { RunTracker, createRunMessage, runIdForMessageId } from '../lib/runs.js';

function fixture() {
  const events = [];
  const message = createRunMessage('fixture', 'session-stream');
  const agent = { id: 'session-stream', status: 'running', inbox: { nextTurn: [], nextStep: [] }, session: {
    get seq() { return events.length; }, snapshotEvents: () => [...events], header: { createdAt: 0 },
  } };
  const tracker = new RunTracker(() => [agent]);
  const append = (type, data) => { const event = { seq: events.length, time: 1, type, data }; events.push(event); tracker.onSessionEvent(agent, event); };
  append('turn/start', { turn: 1 }); append('user/message', message);
  const id = runIdForMessageId(message.id);
  tracker.snapshot(id);
  let revision = 0;
  const frame = (value) => { const frame = { revision: ++revision, ...value }; tracker.onAssistantStream(agent, frame); return frame; };
  const start = (attemptId) => frame({ type: 'start', attemptId, turn: 1, step: 1 });
  const chunk = (attemptId, index, type, text) => frame({ type: 'chunk', attemptId, index, time: 1, chunk: { type, index: 0, text } });
  return { tracker, agent, id, append, frame, start, chunk };
}
const stream = (text, reasoning = '') => [
  { type: 'reasoning-chunks', index: 0, time0: 1, dt: [0], texts: [reasoning] },
  { type: 'text-chunks', index: 1, time0: 1, dt: [0], texts: [text] },
];

test('live V3 text and reasoning wake waiters before settlement, then settle without duplicate deltas', async () => {
  const f = fixture(); f.start('a');
  const initial = f.tracker.snapshot(f.id);
  const waiting = f.tracker.wait(f.id, initial.cursor, 1000);
  f.chunk('a', 0, 'reasoning-delta', 'thinking');
  const reasoning = await waiting;
  assert.equal(reasoning.reasoningDelta, 'thinking'); assert.equal(reasoning.heartbeat, false);
  const frame = f.chunk('a', 1, 'text-delta', 'hello');
  const live = f.tracker.snapshot(f.id, reasoning.cursor);
  assert.equal(live.textDelta, 'hello'); assert.equal(live.reasoningDelta, '');
  f.tracker.onAssistantStream(f.agent, frame); // duplicate transport publication
  assert.equal(f.tracker.snapshot(f.id, live.cursor).textDelta, '');
  f.append('assistant/message', { turn: 1, step: 1, message: { id: 'answer', content: [{ type: 'text', text: 'hello' }] }, stream: stream('hello', 'thinking') });
  const committedBeforeEnd = f.tracker.snapshot(f.id, live.cursor);
  assert.equal(committedBeforeEnd.latestText, 'hello'); assert.equal(committedBeforeEnd.textDelta, '');
  f.frame({ type: 'end', attemptId: 'a', index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 } });
  f.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const final = f.tracker.snapshot(f.id, live.cursor);
  assert.equal(final.status, 'completed'); assert.equal(final.textDelta, ''); assert.equal(final.reasoningDelta, '');
});

test('failed attempts and retries retain their exact prefix, including after bridge restart', () => {
  const f = fixture(); f.start('a'); f.chunk('a', 0, 'text-delta', 'partial');
  const first = f.tracker.snapshot(f.id);
  f.append('assistant/attempt', { turn: 1, step: 1, stream: stream('partial') });
  f.frame({ type: 'end', attemptId: 'a', index: 1, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 2 } });
  f.start('b'); f.chunk('b', 0, 'text-delta', 'retried');
  assert.equal(f.tracker.snapshot(f.id, first.cursor).textDelta, 'retried');
  f.append('assistant/message', { turn: 1, step: 1, message: { id: 'b', content: [{ type: 'text', text: 'retried' }] }, stream: stream('retried') });
  const restarted = new RunTracker(() => [f.agent]).snapshot(f.id, first.cursor);
  assert.equal(restarted.latestText, 'partialretried'); assert.equal(restarted.textDelta, 'retried');
});

test('abandoned transient output explicitly resets and never becomes durable history', () => {
  const f = fixture(); f.start('a'); f.chunk('a', 0, 'text-delta', 'uncommitted');
  const before = f.tracker.snapshot(f.id);
  f.frame({ type: 'end', attemptId: 'a', index: 1, outcome: { kind: 'abandoned' } });
  const reset = f.tracker.snapshot(f.id, before.cursor);
  assert.equal(reset.outputReset, true); assert.equal(reset.latestText, '');
  assert.equal(f.tracker.readMessages(f.agent, 0, 100).events.some(e => e.role === 'assistant'), false);
});

test('cancellation preserves an interrupted settled prefix and accepts legacy cursors', () => {
  const f = fixture(); f.start('a'); f.chunk('a', 0, 'text-delta', 'prefix');
  const before = f.tracker.snapshot(f.id);
  f.append('assistant/message', { turn: 1, step: 1, interrupted: true, message: { id: 'a', content: [] }, stream: stream('prefix') });
  f.frame({ type: 'end', attemptId: 'a', index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 } });
  f.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
  const cancelled = f.tracker.snapshot(f.id, before.cursor);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.textDelta, '');
  assert.equal(f.tracker.snapshot(f.id, '0:0').latestText, 'prefix');
  assert.throws(() => f.tracker.snapshot(f.id, '0:1:2'), /cursor/);
});
