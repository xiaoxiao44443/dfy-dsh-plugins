import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/index.js';

function fixture() {
  const listeners = new Map();
  const config = { enabled: true, behaviorGuidance: true, maxModelSteps: 4, hardStop: true };
  const agent = { id: 'guard-fixture', inject() {}, cancel() {} };
  apply({
    on: (name, callback) => listeners.set(name, callback),
    settings: { register: () => ({ get: () => config, watch() {} }) },
  }, config);
  return { agent, listeners, preStep: listeners.get('agent/pre-step') };
}

test('guard guidance preserves the new request-series boundary and original admitted messages', async () => {
  const { agent, preStep } = fixture();
  const message = { id: 'user-fixture', role: 'user', content: [{ type: 'text', text: 'continue' }] };
  const decision = Object.freeze({ kind: 'enter', startsRequestSeries: true, messages: Object.freeze([message]) });
  const result = await preStep({ agent, turn: 1, step: 0 }, async () => decision);
  assert.equal(result.startsRequestSeries, true);
  assert.equal(result.messages.at(-1), message);
  assert.equal(result.messages.length, 2);
  assert.equal(decision.messages.length, 1);
});

test('both finalization paths preserve the new request-series boundary', async () => {
  const { agent, listeners, preStep } = fixture();
  const enter = async () => ({ kind: 'enter', startsRequestSeries: true, messages: [] });
  for (let step = 0; step < 4; step++) await preStep({ agent, turn: 1, step }, enter);
  const reachedStepLimit = await preStep({ agent, turn: 1, step: 4 }, enter);
  assert.equal(reachedStepLimit.startsRequestSeries, true);
  assert.ok(reachedStepLimit.messages.length > 0);

  // A tool limit can put the guard into finalization before its next pre-step.
  const next = async () => ({ kind: 'allow' });
  const execute = listeners.get('tools/pre-execute');
  await preStep({ agent, turn: 2, step: 0 }, enter);
  for (let i = 0; i < 3; i++) await execute({ agent, name: 'read', arguments: { path: 'same' } }, next);
  const alreadyFinalizing = await preStep({ agent, turn: 2, step: 1 }, enter);
  assert.equal(alreadyFinalizing.startsRequestSeries, true);
  assert.ok(alreadyFinalizing.messages.length > 0);
});

test('a rejected pre-step remains rejected without injecting messages', async () => {
  const { agent, preStep } = fixture();
  const rejected = Object.freeze({ kind: 'reject' });
  assert.equal(await preStep({ agent, turn: 1, step: 0 }, async () => rejected), rejected);
});
