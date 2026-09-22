import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_APPEARANCE_SETTINGS,
  normalizeAppearanceSettings,
  planArtifactPlacements,
} from '../lib/logic.js';

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
  assert.deepEqual(normalizeAppearanceSettings({ collapseCompletedProcess: true }), DEFAULT_APPEARANCE_SETTINGS);
});

test('process-only rows do not create artifact placements', () => {
  const plan = planArtifactPlacements([
    { kind: 'context' },
    { kind: 'assistant-step' },
    { kind: 'tool-call' },
    { kind: 'assistant-step', hasOutput: true },
    { kind: 'tool-call' },
    { kind: 'assistant-step', hasOutput: true },
  ]);
  assert.deepEqual(plan, []);
});

test('trailing process and terminal notices do not create artifact placements', () => {
  const plan = planArtifactPlacements([
    { kind: 'assistant-step', hasOutput: true },
    { kind: 'context' },
    { kind: 'tool-call' },
    { kind: 'turn-error' },
  ]);
  assert.deepEqual(plan, []);
});

test('plugin-rendered artifacts are promoted after the following visible response', () => {
  const plan = planArtifactPlacements([
    { kind: 'context' },
    { kind: 'tool-call' },
    { kind: 'tool-call', hasArtifact: true },
    { kind: 'assistant-step', hasOutput: true },
  ]);
  assert.deepEqual(plan, [
    { outputIndex: 3, artifactIndices: [2] },
  ]);
});

test('a trailing plugin artifact is promoted while later unfinished process remains visible', () => {
  const plan = planArtifactPlacements([
    { kind: 'context' },
    { kind: 'tool-call', hasArtifact: true },
    { kind: 'command' },
  ]);
  assert.deepEqual(plan, [
    { outputIndex: 1, artifactIndices: [1] },
  ]);
});

test('multiple artifacts stay ordered and attach to one visible response', () => {
  const plan = planArtifactPlacements([
    { kind: 'tool-call', hasArtifact: true },
    { kind: 'assistant-step' },
    { kind: 'tool-call', hasArtifact: true },
    { kind: 'assistant-step', hasOutput: true },
  ]);
  assert.deepEqual(plan, [
    { outputIndex: 3, artifactIndices: [0, 2] },
  ]);
});
