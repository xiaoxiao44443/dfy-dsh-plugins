import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_APPEARANCE_SETTINGS,
  customProcessFoldingEnabled,
  normalizeAppearanceSettings,
  planCompletedProcessSegments,
  processFoldingActivated,
} from '../lib/logic.js';

test('custom folding yields to the official Compact transcript across Harness generations', () => {
  assert.equal(customProcessFoldingEnabled(true, undefined), true);
  assert.equal(customProcessFoldingEnabled(true, 'normal'), true);
  assert.equal(customProcessFoldingEnabled(true, 'compact'), false);
  assert.equal(customProcessFoldingEnabled(false, undefined), false);
  assert.equal(customProcessFoldingEnabled(false, 'normal'), false);
});

test('official transcript compatibility runs only when custom folding becomes enabled', () => {
  assert.equal(processFoldingActivated(undefined, true), true);
  assert.equal(processFoldingActivated(false, true), true);
  assert.equal(processFoldingActivated(true, true), false);
  assert.equal(processFoldingActivated(true, false), false);
  assert.equal(processFoldingActivated(false, false), false);
});

test('appearance settings default and clamp the chat font size', () => {
  assert.deepEqual(normalizeAppearanceSettings(undefined), DEFAULT_APPEARANCE_SETTINGS);
  assert.equal(normalizeAppearanceSettings({ chatFontSize: 99 }).chatFontSize, 20);
  assert.equal(normalizeAppearanceSettings({ chatFontSize: 10 }).chatFontSize, 13);
  assert.equal(normalizeAppearanceSettings({ chatFontSize: 17.6 }).chatFontSize, 18);
  assert.equal(normalizeAppearanceSettings({ chatLineHeightRatio: 9 }).chatLineHeightRatio, 1.9);
  assert.equal(normalizeAppearanceSettings({ chatLineHeightRatio: 1 }).chatLineHeightRatio, 1.35);
  assert.equal(normalizeAppearanceSettings({ chatLineHeightRatio: 1.678 }).chatLineHeightRatio, 1.68);
  assert.equal(normalizeAppearanceSettings({ processLineHeightRatio: 9 }).processLineHeightRatio, 1.9);
  assert.equal(normalizeAppearanceSettings({ processLineHeightRatio: 0.5 }).processLineHeightRatio, 1);
  assert.equal(normalizeAppearanceSettings({ processLineHeightRatio: 1.234 }).processLineHeightRatio, 1.23);
  assert.equal(normalizeAppearanceSettings({ collapseCompletedProcess: false }).collapseCompletedProcess, false);
});

test('completed turn plan folds each process run before its own visible text output', () => {
  const plan = planCompletedProcessSegments([
    { kind: 'context' },
    { kind: 'assistant-step' },
    { kind: 'tool-call' },
    { kind: 'assistant-step', hasOutput: true },
    { kind: 'tool-call' },
    { kind: 'assistant-step', hasOutput: true },
  ]);
  assert.deepEqual(plan, [
    { outputIndex: 3, collapseIndices: [0, 1, 2], artifactIndices: [], toolCount: 1, contextCount: 1 },
    { outputIndex: 5, collapseIndices: [4], artifactIndices: [], toolCount: 1, contextCount: 0 },
  ]);
});

test('completed turn plan does not hide trailing process or terminal notices without later text', () => {
  const plan = planCompletedProcessSegments([
    { kind: 'assistant-step', hasOutput: true },
    { kind: 'context' },
    { kind: 'tool-call' },
    { kind: 'turn-error' },
  ]);
  assert.deepEqual(plan, []);
});

test('plugin-rendered artifacts are promoted after the following visible response', () => {
  const plan = planCompletedProcessSegments([
    { kind: 'context' },
    { kind: 'tool-call' },
    { kind: 'tool-call', hasArtifact: true },
    { kind: 'assistant-step', hasOutput: true },
  ]);
  assert.deepEqual(plan, [
    { outputIndex: 3, collapseIndices: [0, 1, 2], artifactIndices: [2], toolCount: 2, contextCount: 1 },
  ]);
});

test('a trailing plugin artifact is promoted while later unfinished process remains visible', () => {
  const plan = planCompletedProcessSegments([
    { kind: 'context' },
    { kind: 'tool-call', hasArtifact: true },
    { kind: 'command' },
  ]);
  assert.deepEqual(plan, [
    { outputIndex: 1, collapseIndices: [0, 1], artifactIndices: [1], toolCount: 1, contextCount: 1 },
  ]);
});

test('multiple artifacts stay ordered and attach to one visible response', () => {
  const plan = planCompletedProcessSegments([
    { kind: 'tool-call', hasArtifact: true },
    { kind: 'assistant-step' },
    { kind: 'tool-call', hasArtifact: true },
    { kind: 'assistant-step', hasOutput: true },
  ]);
  assert.deepEqual(plan, [
    { outputIndex: 3, collapseIndices: [0, 1, 2], artifactIndices: [0, 2], toolCount: 2, contextCount: 0 },
  ]);
});
