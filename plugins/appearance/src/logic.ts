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
  chatFontSize: number;
  chatLineHeightRatio: number;
  processLineHeightRatio: number;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
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
    chatFontSize,
    chatLineHeightRatio,
    processLineHeightRatio,
  };
}

export interface ArtifactFlowNode {
  kind: string;
  hasOutput?: boolean;
  hasArtifact?: boolean;
}

export interface ArtifactPlacementPlan {
  outputIndex: number;
  artifactIndices: number[];
}

/** Keep plugin artifacts beside visible output without controlling process disclosure. */
export function planArtifactPlacements(nodes: readonly ArtifactFlowNode[]): ArtifactPlacementPlan[] {
  const placements: ArtifactPlacementPlan[] = [];
  let artifacts: number[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node?.hasOutput === true) {
      if (artifacts.length > 0) placements.push({ outputIndex: index, artifactIndices: artifacts });
      artifacts = [];
    } else if (node?.hasArtifact === true) {
      artifacts.push(index);
    }
  }
  const lastArtifact = artifacts.at(-1);
  if (lastArtifact !== undefined) placements.push({ outputIndex: lastArtifact, artifactIndices: artifacts });
  return placements;
}
