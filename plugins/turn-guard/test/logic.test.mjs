import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginFinalization,
  canonicalToolSignature,
  claimFinalizationStep,
  createTurnState,
  currentHardLimit,
  ensureTurnState,
  failureFingerprint,
  finalizationMessage,
  normalizeTurnGuardSettings,
  registerModelStep,
  registerToolCall,
  registerToolResult,
  takeBehaviorGuidance,
  takeConvergenceReminder,
  toolFailureFingerprint,
} from '../lib/logic.js';

test('normalizes unsafe settings and keeps warning below the hard step limit', () => {
  const settings = normalizeTurnGuardSettings({
    warningStep: 99,
    maxModelSteps: 7,
    maxToolCalls: -10,
    maxDurationMinutes: 999,
    repeatedCallLimit: 1,
  });
  assert.equal(settings.warningStep, 6);
  assert.equal(settings.maxModelSteps, 7);
  assert.equal(settings.maxToolCalls, 8);
  assert.equal(settings.maxDurationMinutes, 180);
  assert.equal(settings.repeatedCallLimit, 2);
  assert.equal(settings.behaviorGuidance, true);
});

test('behavior guidance is optional and emitted once per turn', () => {
  const state = createTurnState(1, 0);
  const settings = normalizeTurnGuardSettings({ behaviorGuidance: true });
  const guidance = takeBehaviorGuidance(state, settings) ?? '';
  assert.match(guidance, /最新补充和纠正覆盖冲突的旧信息/u);
  assert.match(guidance, /专名、路径、数字、代码和搜索词必须原样/u);
  assert.match(guidance, /不能单独触发技能或扩大任务范围/u);
  assert.match(guidance, /可观察的完成条件与最小验证方式/u);
  assert.match(guidance, /减少关键不确定性、推进所需状态，或验证结果/u);
  assert.match(guidance, /失败、超时、空结果/u);
  assert.match(guidance, /不能因相似而合并/u);
  assert.match(guidance, /已验证、合理推断或未知/u);
  assert.match(guidance, /决定性结论.*禁止写成确定事实/u);
  assert.match(guidance, /下一次输出必须直接面向用户/u);
  assert.match(guidance, /简单问题直接简洁回答/u);
  assert.match(guidance, /URL、本地路径、命令和资源不得混用/u);
  assert.doesNotMatch(guidance, /图片生成|角色识别|山茶花/u);
  assert.equal(takeBehaviorGuidance(state, settings), undefined);

  const disabledState = createTurnState(2, 0);
  const disabledSettings = normalizeTurnGuardSettings({ behaviorGuidance: false });
  assert.equal(takeBehaviorGuidance(disabledState, disabledSettings), undefined);
});

test('canonical tool signatures ignore object key order', () => {
  assert.equal(
    canonicalToolSignature('shell', { command: 'pwd', options: { cwd: '/tmp', tty: false } }),
    canonicalToolSignature('shell', { options: { tty: false, cwd: '/tmp' }, command: 'pwd' }),
  );
  assert.notEqual(
    canonicalToolSignature('shell', { command: 'pwd' }),
    canonicalToolSignature('shell', { command: 'ls' }),
  );
});

test('a model step is counted only once and state resets for a new turn', () => {
  let state = createTurnState(3, 100);
  registerModelStep(state, 0);
  registerModelStep(state, 0);
  registerModelStep(state, 1);
  assert.equal(state.modelSteps, 2);
  assert.equal(ensureTurnState(state, 3, 200), state);
  state = ensureTurnState(state, 4, 300);
  assert.equal(state.turn, 4);
  assert.equal(state.modelSteps, 0);
  assert.equal(state.startedAt, 300);
});

test('detects repeated direct tool calls at the configured threshold', () => {
  const settings = normalizeTurnGuardSettings({ repeatedCallLimit: 3 });
  const state = createTurnState(1, 0);
  const signature = canonicalToolSignature('read', { path: '/tmp/a' });
  registerToolCall(state, signature);
  registerToolCall(state, signature);
  assert.equal(currentHardLimit(state, settings, 1), undefined);
  registerToolCall(state, signature);
  assert.equal(currentHardLimit(state, settings, 1)?.kind, 'repeated-call');
});

test('same failure streak resets after success', () => {
  const settings = normalizeTurnGuardSettings({ repeatedFailureLimit: 3 });
  const state = createTurnState(1, 0);
  const fingerprint = failureFingerprint('ENOENT', 'No such file: /tmp/a');
  registerToolResult(state, fingerprint);
  registerToolResult(state, fingerprint);
  assert.equal(currentHardLimit(state, settings, 1), undefined);
  registerToolResult(state, undefined);
  registerToolResult(state, fingerprint);
  assert.equal(state.repeatedFailureStreak, 1);
});

test('the same error from a different approach does not share a failure fingerprint', () => {
  const message = 'Permission denied';
  assert.notEqual(
    toolFailureFingerprint('read', { path: '/a' }, 'EACCES', message),
    toolFailureFingerprint('shell', { command: 'type /a' }, 'EACCES', message),
  );
  assert.notEqual(
    toolFailureFingerprint('read', { path: '/a' }, 'EACCES', message),
    toolFailureFingerprint('read', { path: '/b' }, 'EACCES', message),
  );
});

test('convergence reminder is emitted only once', () => {
  const settings = normalizeTurnGuardSettings({ warningStep: 4, maxModelSteps: 10 });
  const state = createTurnState(1, 0);
  for (let step = 0; step < 4; step += 1) registerModelStep(state, step);
  const reminder = takeConvergenceReminder(state, settings, 1) ?? '';
  assert.match(reminder, /任务守卫检查点/u);
  assert.match(reminder, /只选择一种动作/u);
  assert.match(reminder, /失败、超时、空结果/u);
  assert.match(reminder, /下一次输出必须直接面向用户/u);
  assert.equal(takeConvergenceReminder(state, settings, 2), undefined);
});

test('convergence reminder does not wait for seventy percent of a large tool budget', () => {
  const settings = normalizeTurnGuardSettings({ maxToolCalls: 50, warningStep: 12 });
  const state = createTurnState(1, 0);
  for (let call = 0; call < 5; call += 1) registerToolCall(state, `search:${String(call)}`);
  assert.equal(takeConvergenceReminder(state, settings, 1), undefined);
  registerToolCall(state, 'search:5');
  assert.match(takeConvergenceReminder(state, settings, 2) ?? '', /结果将如何改变下一步/u);
});

test('detects hard step, tool and duration budgets', () => {
  const settings = normalizeTurnGuardSettings({ maxModelSteps: 4, maxToolCalls: 8, maxDurationMinutes: 1 });
  const stepState = createTurnState(1, 0);
  for (let step = 0; step < 5; step += 1) registerModelStep(stepState, step);
  assert.equal(currentHardLimit(stepState, settings, 1)?.kind, 'steps');

  const toolState = createTurnState(1, 0);
  for (let call = 0; call < 9; call += 1) registerToolCall(toolState, `shell:${String(call)}`);
  assert.equal(currentHardLimit(toolState, settings, 1)?.kind, 'tools');

  const durationState = createTurnState(1, 0);
  assert.equal(currentHardLimit(durationState, settings, 60_001)?.kind, 'duration');
});

test('hard limits reserve exactly one model step for a visible final explanation', () => {
  const state = createTurnState(1, 0);
  const limit = { kind: 'repeated-call', reason: '相同工具与参数已连续出现 3 次' };
  assert.equal(beginFinalization(state, limit), true);
  assert.equal(beginFinalization(state, limit), false);
  assert.equal(claimFinalizationStep(state, 4), true);
  assert.equal(claimFinalizationStep(state, 4), true);
  assert.equal(claimFinalizationStep(state, 5), false);
  assert.match(finalizationMessage(limit), /已验证结果、未完成部分和可行下一步/u);
  assert.match(finalizationMessage(limit), /不要调用工具/u);
  assert.match(finalizationMessage(limit), /伪造完成/u);
});
