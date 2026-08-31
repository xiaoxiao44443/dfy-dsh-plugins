export const DEFAULT_CHAT_FONT_SIZE = 16;
export const MIN_CHAT_FONT_SIZE = 13;
export const MAX_CHAT_FONT_SIZE = 20;
export const DEFAULT_CHAT_LINE_HEIGHT_RATIO = 1.65;
export const MIN_CHAT_LINE_HEIGHT_RATIO = 1.35;
export const MAX_CHAT_LINE_HEIGHT_RATIO = 1.9;
export const DEFAULT_PROCESS_LINE_HEIGHT_RATIO = 1.4;
export const MIN_PROCESS_LINE_HEIGHT_RATIO = 1;
export const MAX_PROCESS_LINE_HEIGHT_RATIO = 1.9;

export interface AppearanceSettings {
  collapseCompletedProcess: boolean;
  chatFontSize: number;
  chatLineHeightRatio: number;
  processLineHeightRatio: number;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  collapseCompletedProcess: true,
  chatFontSize: DEFAULT_CHAT_FONT_SIZE,
  chatLineHeightRatio: DEFAULT_CHAT_LINE_HEIGHT_RATIO,
  processLineHeightRatio: DEFAULT_PROCESS_LINE_HEIGHT_RATIO,
};

export function normalizeAppearanceSettings(value: Partial<AppearanceSettings> | undefined): AppearanceSettings {
  const requestedSize = value?.chatFontSize;
  const chatFontSize = typeof requestedSize === 'number' && Number.isFinite(requestedSize)
    ? Math.min(MAX_CHAT_FONT_SIZE, Math.max(MIN_CHAT_FONT_SIZE, Math.round(requestedSize)))
    : DEFAULT_CHAT_FONT_SIZE;
  const requestedLineHeight = value?.chatLineHeightRatio;
  const chatLineHeightRatio = typeof requestedLineHeight === 'number' && Number.isFinite(requestedLineHeight)
    ? Math.min(
      MAX_CHAT_LINE_HEIGHT_RATIO,
      Math.max(MIN_CHAT_LINE_HEIGHT_RATIO, Math.round(requestedLineHeight * 100) / 100),
    )
    : DEFAULT_CHAT_LINE_HEIGHT_RATIO;
  const requestedProcessLineHeight = value?.processLineHeightRatio;
  const processLineHeightRatio = typeof requestedProcessLineHeight === 'number' && Number.isFinite(requestedProcessLineHeight)
    ? Math.min(
      MAX_PROCESS_LINE_HEIGHT_RATIO,
      Math.max(MIN_PROCESS_LINE_HEIGHT_RATIO, Math.round(requestedProcessLineHeight * 100) / 100),
    )
    : DEFAULT_PROCESS_LINE_HEIGHT_RATIO;
  return {
    collapseCompletedProcess: value?.collapseCompletedProcess ?? true,
    chatFontSize,
    chatLineHeightRatio,
    processLineHeightRatio,
  };
}

export const PROCESS_NODE_KINDS = new Set([
  'context',
  'tool-call',
  'command',
  'manual-compaction',
  'compaction',
  'model-retry',
]);

export interface ProcessFlowNode {
  kind: string;
  hasOutput?: boolean;
  hasArtifact?: boolean;
}

export interface ProcessSegmentPlan {
  outputIndex: number;
  collapseIndices: number[];
  artifactIndices: number[];
  toolCount: number;
  contextCount: number;
}

/**
 * Keep the plugin's per-response disclosure off while the built-in Compact
 * transcript is active. Undefined means the older Harness has no such policy.
 */
export function customProcessFoldingEnabled(
  requested: boolean,
  officialTranscriptView: 'normal' | 'compact' | undefined,
): boolean {
  return requested && officialTranscriptView !== 'compact';
}

/** Detect the initial/rising edge that may normalize the official transcript. */
export function processFoldingActivated(
  previouslyEnabled: boolean | undefined,
  enabled: boolean,
): boolean {
  return enabled && previouslyEnabled !== true;
}

/** Group each process run with the next visible output and attach plugin artifacts to that output. */
export function planCompletedProcessSegments(nodes: readonly ProcessFlowNode[]): ProcessSegmentPlan[] {
  const segments: ProcessSegmentPlan[] = [];
  let pending: number[] = [];
  let artifacts: number[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node?.hasOutput === true) {
      if (pending.length > 0) {
        segments.push({
          outputIndex: index,
          collapseIndices: pending,
          artifactIndices: artifacts,
          toolCount: pending.filter((item) => nodes[item]?.kind === 'tool-call' || nodes[item]?.kind === 'command').length,
          contextCount: pending.filter((item) => nodes[item]?.kind === 'context').length,
        });
      }
      pending = [];
      artifacts = [];
      continue;
    }
    if (node?.hasArtifact === true) {
      pending.push(index);
      artifacts.push(index);
      continue;
    }
    if (PROCESS_NODE_KINDS.has(node?.kind ?? '') || node?.kind === 'assistant-step') {
      pending.push(index);
    }
  }
  const lastArtifact = artifacts.at(-1);
  if (lastArtifact !== undefined) {
    const terminalPending = pending.filter((index) => index <= lastArtifact);
    const terminalArtifacts = artifacts.filter((index) => index <= lastArtifact);
    if (terminalPending.length > 0) {
      segments.push({
        outputIndex: lastArtifact,
        collapseIndices: terminalPending,
        artifactIndices: terminalArtifacts,
        toolCount: terminalPending.filter((item) => nodes[item]?.kind === 'tool-call' || nodes[item]?.kind === 'command').length,
        contextCount: terminalPending.filter((item) => nodes[item]?.kind === 'context').length,
      });
    }
  }
  return segments;
}
