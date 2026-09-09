/** @dfy-plugins/dsh-wallpaper Client 半区：全局背景层、持久化与设置页。 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  IconChevronDownOutline14,
  IconCloseOutline16,
  Menu,
  type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives';

import {
  backgroundPositionWithOffset,
  DEFAULT_SETTINGS,
  defaultRegionSettings,
  hexToRgb,
  modeStyle,
  normalizeSettings,
  surfaceLayerAlphas,
  type WallpaperMode,
  type WallpaperPosition,
  type WallpaperSettings,
  type WallpaperSurfaceSettings,
  type WallpaperRegion,
  type WallpaperRegionSettings,
  type WallpaperTarget,
} from './logic.js';
import { REGIONS_ATTRIBUTE, REGION_STYLES, REGION_VARIABLES, regionVariables } from './regions.js';

interface SlotEntryOptions {
  name: string;
  id?: string;
  order?: number;
  label?: string | (() => string);
  children?: unknown;
}

interface ClientCtx {
  slots: {
    inject(name: string, register: () => unknown): unknown;
    register(options: SlotEntryOptions, component: unknown): unknown;
  };
  effect(execute: () => void | (() => void), label?: string): unknown;
}

export const name = 'wallpaper';
export const inject = ['slots'];

const OWNER = 'dsh-wallpaper';
const STYLE_ID = '@dfy-plugins/dsh-wallpaper';
const ACTIVE_ATTRIBUTE = 'data-dsh-wallpaper-active';
const API_BASE = '/api/dsh-wallpaper';
const SETTINGS_DEBOUNCE_MS = 180;
const PANEL_POSITION_KEY = 'dsh-wallpaper.panel-position.v1';
const PANEL_MARGIN = 12;
const PAGE_RUNTIME_KEY = '__xiao443DshWallpaperPageRuntime__';
const CLIENT_BUILD_TOKEN = Object.freeze({});

const BODY_VARIABLES = [
  '--dsh-wallpaper-image-opacity',
  '--dsh-wallpaper-blur',
  '--dsh-wallpaper-inset',
  '--dsh-wallpaper-mask-rgb',
  '--dsh-wallpaper-mask-opacity',
  '--dsh-wallpaper-surface-alpha-1',
  '--dsh-wallpaper-surface-alpha-2',
  '--dsh-wallpaper-surface-alpha-3',
] as const;

const MODE_OPTIONS: ReadonlyArray<{ value: WallpaperMode; label: string; hint: string }> = [
  { value: 'cover', label: '覆盖窗口', hint: '填满窗口，必要时裁切图片' },
  { value: 'contain', label: '完整显示', hint: '显示完整图片，可能留有空白' },
  { value: 'stretch', label: '拉伸填满', hint: '忽略原始比例铺满窗口' },
  { value: 'fit-width', label: '适应宽度', hint: '宽度铺满，高度按比例缩放' },
  { value: 'fit-height', label: '适应高度', hint: '高度铺满，宽度按比例缩放' },
  { value: 'center', label: '原始大小', hint: '按原始尺寸显示，不缩放' },
  { value: 'tile', label: '平铺', hint: '按原始尺寸重复图片' },
];

const POSITION_OPTIONS: ReadonlyArray<{ value: WallpaperPosition; label: string }> = [
  { value: 'left top', label: '左上' },
  { value: 'center top', label: '顶部居中' },
  { value: 'right top', label: '右上' },
  { value: 'left center', label: '左侧居中' },
  { value: 'center center', label: '正中' },
  { value: 'right center', label: '右侧居中' },
  { value: 'left bottom', label: '左下' },
  { value: 'center bottom', label: '底部居中' },
  { value: 'right bottom', label: '右下' },
];

const STYLES = `
${REGION_STYLES}
body[${ACTIVE_ATTRIBUTE}] {
  isolation: isolate;
  --dsh-wallpaper-surface-rgb: 255 255 255;
  --dsh-wallpaper-surface-1: rgb(var(--dsh-wallpaper-surface-rgb) / var(--dsh-wallpaper-surface-alpha-1));
  --dsh-wallpaper-surface-2: rgb(var(--dsh-wallpaper-surface-rgb) / var(--dsh-wallpaper-surface-alpha-2));
  --dsh-wallpaper-surface-3: rgb(var(--dsh-wallpaper-surface-rgb) / var(--dsh-wallpaper-surface-alpha-3));
  --dsw-alias-bg-base: transparent;
  --dsw-specific-sidebar-fill: transparent;
  --dsw-alias-bg-layer-1: var(--dsh-wallpaper-surface-1);
  --dsw-alias-bg-layer-2: var(--dsh-wallpaper-surface-2);
  --dsw-alias-bg-layer-3: var(--dsh-wallpaper-surface-3);
  --dsw-alias-bg-module-platform: var(--dsh-wallpaper-surface-2);
  --dsw-specific-input-major: var(--dsh-wallpaper-surface-2);
  --dsw-specific-selector: var(--dsh-wallpaper-surface-2);
  --dsw-specific-tip: var(--dsh-wallpaper-surface-2);
  --dsw-alias-button-elevated-fill: var(--dsh-wallpaper-surface-2);
  --dsw-alias-button-floating-fill: var(--dsh-wallpaper-surface-3);
  --dsw-alias-markdown-code-block: var(--dsh-wallpaper-surface-2);
  --dsw-alias-markdown-code-block-banner: var(--dsh-wallpaper-surface-3);
  --dsw-alias-markdown-inline-code: var(--dsh-wallpaper-surface-2);
}
body[${ACTIVE_ATTRIBUTE}][data-ds-dark-theme] {
  --dsh-wallpaper-surface-rgb: 18 22 32;
}
[data-dsh-wallpaper-owner='${OWNER}'][data-dsh-wallpaper-layer] {
  display: none;
  position: fixed;
  pointer-events: none;
  user-select: none;
}
body[${ACTIVE_ATTRIBUTE}] > [data-dsh-wallpaper-owner='${OWNER}'][data-dsh-wallpaper-layer='media'] {
  display: block;
  inset: var(--dsh-wallpaper-inset, 0px);
  z-index: -2;
  background-color: transparent;
  background-position: center center;
  background-repeat: no-repeat;
  background-size: cover;
  filter: blur(var(--dsh-wallpaper-blur, 0px));
  opacity: var(--dsh-wallpaper-image-opacity, 1);
}
body[${ACTIVE_ATTRIBUTE}] > [data-dsh-wallpaper-owner='${OWNER}'][data-dsh-wallpaper-layer='mask'] {
  display: block;
  inset: 0;
  z-index: -1;
  background: rgb(var(--dsh-wallpaper-mask-rgb, 0 0 0) / var(--dsh-wallpaper-mask-opacity, .18));
}

[data-dsh-wallpaper-owner='${OWNER}'][data-dsh-wallpaper-panel-root] {
  position: fixed;
  inset: 0;
  z-index: 900;
  pointer-events: none;
}
.dsh-wallpaper-floating {
  position: absolute;
  display: flex;
  width: min(480px, calc(100vw - 24px));
  max-height: min(760px, calc(100vh - 24px));
  flex-direction: column;
  overflow: hidden;
  border: 1px solid rgba(34, 38, 48, .14);
  border-radius: 18px;
  background: rgba(249, 250, 252, .91);
  box-shadow: 0 22px 64px rgba(25, 31, 43, .22), 0 4px 16px rgba(25, 31, 43, .12);
  color: var(--dsw-alias-label-primary);
  pointer-events: auto;
  backdrop-filter: blur(24px) saturate(1.18);
  -webkit-backdrop-filter: blur(24px) saturate(1.18);
}
body[data-ds-dark-theme] .dsh-wallpaper-floating {
  border-color: rgba(255, 255, 255, .12);
  background: rgba(28, 30, 36, .91);
  box-shadow: 0 24px 72px rgba(0, 0, 0, .48), 0 4px 18px rgba(0, 0, 0, .28);
}
.dsh-wallpaper-floating:focus { outline: none; }
.dsh-wallpaper-floating-header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 14px 13px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  cursor: default;
  touch-action: none;
  user-select: none;
}
.dsh-wallpaper-floating-heading { min-width: 0; }
.dsh-wallpaper-floating-title { margin: 0; font-size: 16px; font-weight: 680; line-height: 23px; }
.dsh-wallpaper-floating-subtitle { overflow: hidden; margin: 1px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 17px; text-overflow: ellipsis; white-space: nowrap; }
.dsh-wallpaper-close {
  display: grid;
  width: 28px;
  height: 28px;
  flex: none;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 28px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.dsh-wallpaper-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-wallpaper-floating-body { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.dsh-wallpaper-settings { padding: 16px 18px 20px; color: inherit; }
.dsh-wallpaper-targets { display:flex; gap:4px; padding:4px; margin-bottom:16px; border-radius:12px; background:var(--dsw-alias-bg-module-platform); }
.dsh-wallpaper-targets button { flex:1; padding:9px 8px; border:0; border-radius:9px; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:13px; cursor:pointer; }
.dsh-wallpaper-targets button[aria-pressed=true] { background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); box-shadow:0 1px 4px rgba(0,0,0,.08); font-weight:600; }
.dsh-wallpaper-targets button:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }
.dsh-wallpaper-region-source { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
.dsh-wallpaper-region-source .dsh-wallpaper-source-hint { margin: 0; }
.dsh-wallpaper-controls { min-width:0; margin:0; padding:0; border:0; }
.dsh-wallpaper-controls:disabled { opacity:.6; }
.dsh-wallpaper-launcher { padding: 20px; color: var(--dsw-alias-label-tertiary); font-size: 13px; }
.dsh-wallpaper-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px; background: rgba(127,127,127,.06); overflow: hidden; }
.dsh-wallpaper-source { display: grid; grid-template-columns: 138px minmax(0,1fr); gap: 14px; align-items: center; padding: 14px; }
.dsh-wallpaper-preview { aspect-ratio: 16 / 10; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background-color: rgba(127,127,127,.1); background-position: center; background-repeat: no-repeat; background-size: cover; box-shadow: inset 0 0 0 1px rgba(255,255,255,.03); }
.dsh-wallpaper-settings[data-wallpaper-target='sidebar'] .dsh-wallpaper-preview { aspect-ratio: 2 / 3; }
.dsh-wallpaper-preview[data-empty] { display: grid; place-items: center; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-wallpaper-source-copy { min-width: 0; }
.dsh-wallpaper-source-name { overflow: hidden; margin-bottom: 4px; color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.dsh-wallpaper-source-hint { margin: 0 0 12px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-wallpaper-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dsh-wallpaper-button { min-height: 34px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-button-elevated-fill); color: inherit; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.dsh-wallpaper-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
.dsh-wallpaper-button:disabled { cursor: wait; opacity: .48; }
.dsh-wallpaper-button[data-danger] { color: var(--dsw-alias-state-error-primary); }
.dsh-wallpaper-file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.dsh-wallpaper-error { margin: 12px 16px 0; padding: 9px 11px; border-radius: 9px; color: var(--dsw-alias-state-error-primary); background: rgba(229,72,77,.1); font-size: 12px; line-height: 18px; }
.dsh-wallpaper-enable { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 13px 16px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-wallpaper-enable-copy { min-width: 0; }
.dsh-wallpaper-enable-title { font-size: 13px; font-weight: 600; line-height: 20px; }
.dsh-wallpaper-enable-hint { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-wallpaper-switch { position: relative; flex: none; width: 40px; height: 22px; }
.dsh-wallpaper-switch input { position: absolute; opacity: 0; }
.dsh-wallpaper-switch span { position: absolute; inset: 0; border-radius: 999px; background: rgba(127,127,127,.32); cursor: pointer; transition: background .15s ease; }
.dsh-wallpaper-switch span::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: white; box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: transform .15s ease; }
.dsh-wallpaper-switch input:checked + span { background: var(--dsw-alias-state-business-primary); }
.dsh-wallpaper-switch input:checked + span::after { transform: translateX(18px); }
.dsh-wallpaper-switch input:disabled + span { cursor: not-allowed; opacity: .45; }
.dsh-wallpaper-section { margin-top: 20px; }
.dsh-wallpaper-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 0 2px 9px; }
.dsh-wallpaper-section-title { margin: 0; font-size: 13px; font-weight: 650; }
.dsh-wallpaper-section-note { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-wallpaper-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
.dsh-wallpaper-field { display: flex; flex-direction: column; gap: 7px; min-width: 0; padding: 12px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: rgba(127,127,127,.045); }
.dsh-wallpaper-field-label { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600; }
.dsh-wallpaper-field-output { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; font-weight: 500; }
.dsh-wallpaper-select-menu { display: flex; width: 100%; }
.dsh-wallpaper-select-trigger { display: flex; width: 100%; height: 36px; align-items: center; justify-content: space-between; gap: 12px; padding: 0 14px; border: 0; border-radius: 18px; outline: none; background: var(--dsw-alias-bg-module-platform); color: inherit; cursor: pointer; font: inherit; font-size: 14px; line-height: 22px; }
.dsh-wallpaper-select-trigger:hover, .dsh-wallpaper-select-trigger[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-wallpaper-select-trigger:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary); }
.dsh-wallpaper-select-trigger svg { flex: none; }
.dsh-wallpaper-range-row { display: grid; grid-template-columns: minmax(0,1fr) 42px; gap: 10px; align-items: center; }
.dsh-wallpaper-field input[type='range'] { width: 100%; accent-color: var(--dsw-alias-state-business-primary); }
.dsh-wallpaper-number { text-align: right; color: var(--dsw-alias-label-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.dsh-wallpaper-number-input { box-sizing: border-box; width: 64px; height: 30px; padding: 0 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; outline: none; background: var(--dsw-alias-bg-layer-1); color: inherit; text-align: right; font: inherit; font-size: 12px; font-variant-numeric: tabular-nums; }
.dsh-wallpaper-number-input:focus-visible { border-color: var(--dsw-alias-state-business-primary); }
.dsh-wallpaper-offset-row { grid-template-columns: minmax(0,1fr) 64px; }
.dsh-wallpaper-color-row { display: grid; grid-template-columns: 42px minmax(0,1fr); gap: 10px; align-items: center; }
.dsh-wallpaper-color { width: 42px; height: 34px; padding: 2px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px; background: transparent; cursor: pointer; }
.dsh-wallpaper-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; }
.dsh-wallpaper-footer .dsh-wallpaper-storage-note { flex: 1 1 200px; min-width: 0; }
.dsh-wallpaper-footer .dsh-wallpaper-button { flex: none; margin-left: auto; white-space: nowrap; }
.dsh-wallpaper-storage-note { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 17px; }
@media (max-width: 680px) {
  .dsh-wallpaper-floating { border-radius: 15px; }
  .dsh-wallpaper-source { grid-template-columns: 1fr; }
  .dsh-wallpaper-preview { max-width: 260px; }
  .dsh-wallpaper-grid { grid-template-columns: 1fr; }
  .dsh-wallpaper-footer { align-items: stretch; flex-direction: column; }
  .dsh-wallpaper-footer .dsh-wallpaper-storage-note { flex-basis: auto; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-wallpaper-switch span, .dsh-wallpaper-switch span::after { transition: none; }
}
`;

function installStyles(): () => void {
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin=${JSON.stringify(STYLE_ID)}]`);
  const tag = document.createElement('style');
  tag.dataset.plugin = STYLE_ID;
  tag.textContent = STYLES;
  if (existing === null) document.head.appendChild(tag);
  else existing.replaceWith(tag);
  return () => tag.remove();
}

interface WallpaperSnapshot {
  settings: WallpaperSettings;
  hasImage: boolean;
  previewUrl: string | null;
  regionImages: Record<WallpaperRegion, string | null>;
  panelOpen: boolean;
  loading: boolean;
  error: string | null;
}

interface ApiState {
  settings: WallpaperSettings;
  hasImage: boolean;
  imageUrl: string | null;
  regionImages: Record<WallpaperRegion, { hasImage: boolean; imageUrl: string | null }>;
}

async function readApiState(response: Response): Promise<ApiState> {
  const payload = (await response.json()) as Partial<ApiState> & { error?: unknown };
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
  }
  const settings = normalizeSettings(payload.settings);
  const imageUrl = typeof payload.imageUrl === 'string' ? payload.imageUrl : null;
  const hasImage = payload.hasImage === true && imageUrl !== null;
  const regionImage = (region: WallpaperRegion): { hasImage: boolean; imageUrl: string | null } => {
    const image = payload.regionImages?.[region];
    return { hasImage: image?.hasImage === true, imageUrl: image?.hasImage === true && typeof image.imageUrl === 'string' ? image.imageUrl : null };
  };
  return { settings, hasImage, imageUrl: hasImage ? imageUrl : null, regionImages: { settings: regionImage('settings'), sidebar: regionImage('sidebar') } };
}

async function validateImage(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('无法读取这张图片'));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function cssUrl(url: string): string {
  return `url(${JSON.stringify(url)})`;
}

class WallpaperController {
  private settings = { ...DEFAULT_SETTINGS };
  private imageUrl: string | null = null;
  private regionImages: Record<WallpaperRegion, string | null> = { settings: null, sidebar: null };
  private panelOpen = false;
  private mounted = false;
  private disposed = false;
  private persistTimer: number | null = null;
  private persistTail: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private mediaLayer: HTMLDivElement | null = null;
  private maskLayer: HTMLDivElement | null = null;
  private panelHost: HTMLDivElement | null = null;
  private panelRoot: Root | null = null;
  private snapshot: WallpaperSnapshot = {
    settings: this.settings,
    hasImage: false,
    previewUrl: null,
    regionImages: this.regionImages,
    panelOpen: false,
    loading: true,
    error: null,
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): WallpaperSnapshot => this.snapshot;

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.disposed = false;

    document.querySelectorAll(`[data-dsh-wallpaper-owner='${OWNER}']`).forEach((node) => node.remove());
    document.body.removeAttribute(ACTIVE_ATTRIBUTE);
    document.body.removeAttribute(REGIONS_ATTRIBUTE);

    const media = document.createElement('div');
    media.dataset.dshWallpaperOwner = OWNER;
    media.dataset.dshWallpaperLayer = 'media';
    media.setAttribute('aria-hidden', 'true');

    const mask = document.createElement('div');
    mask.dataset.dshWallpaperOwner = OWNER;
    mask.dataset.dshWallpaperLayer = 'mask';
    mask.setAttribute('aria-hidden', 'true');

    const panelHost = document.createElement('div');
    panelHost.dataset.dshWallpaperOwner = OWNER;
    panelHost.dataset.dshWallpaperPanelRoot = '';

    document.body.append(media, mask, panelHost);
    this.mediaLayer = media;
    this.maskLayer = mask;
    this.panelHost = panelHost;
    this.panelRoot = createRoot(panelHost);
    this.panelRoot.render(<WallpaperFloatingPanel controller={this} />);
    this.applyVisualState();
    void this.restoreState();
  }

  dispose(): void {
    if (!this.mounted) return;
    this.disposed = true;
    this.mounted = false;
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
      void this.queuePersist(this.settings);
    }
    this.imageUrl = null;
    this.regionImages = { settings: null, sidebar: null };
    this.panelOpen = false;
    this.panelRoot?.unmount();
    this.mediaLayer?.remove();
    this.maskLayer?.remove();
    this.panelHost?.remove();
    this.mediaLayer = null;
    this.maskLayer = null;
    this.panelHost = null;
    this.panelRoot = null;
    document.body.removeAttribute(ACTIVE_ATTRIBUTE);
    document.body.removeAttribute(REGIONS_ATTRIBUTE);
    for (const variable of [...BODY_VARIABLES, ...REGION_VARIABLES]) document.body.style.removeProperty(variable);
    this.listeners.clear();
  }

  openPanel(): void {
    if (!this.mounted) return;
    if (!this.panelOpen) {
      this.panelOpen = true;
      this.publish();
    }
    window.requestAnimationFrame(() => {
      this.panelHost
        ?.querySelector<HTMLElement>('.dsh-wallpaper-floating')
        ?.focus({ preventScroll: true });
    });
  }

  closePanel(): void {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    this.publish();
  }

  update(patch: Partial<WallpaperSettings>): void {
    this.settings = normalizeSettings({ ...this.settings, ...patch });
    this.schedulePersist();
    this.applyVisualState();
    this.publish({ error: null });
  }

  updateRegion(region: WallpaperRegion, patch: Partial<WallpaperRegionSettings>): void {
    this.update({ regions: { ...this.settings.regions, [region]: { ...this.settings.regions[region], ...patch } } });
  }

  resetAppearance(target: WallpaperTarget): void {
    if (target !== 'global') {
      this.updateRegion(target, { ...defaultRegionSettings(), imageName: this.settings.regions[target].imageName });
      return;
    }
    this.settings = {
      ...DEFAULT_SETTINGS,
      regions: this.settings.regions,
      enabled: this.settings.enabled,
      imageName: this.settings.imageName,
    };
    this.schedulePersist();
    this.applyVisualState();
    this.publish({ error: null });
  }

  async setImage(file: File, target: WallpaperTarget): Promise<void> {
    if (!file.type.startsWith('image/')) {
      this.publish({ error: '请选择图片文件。' });
      return;
    }
    this.publish({ loading: true, error: null });
    try {
      await validateImage(file);
      await this.flushPersist();
      const response = await fetch(`${API_BASE}/image?region=${target}`, {
        method: 'PUT',
        headers: {
          'Content-Type': file.type,
          'X-DSH-Wallpaper-Filename': encodeURIComponent(file.name),
        },
        body: file,
      });
      const state = await readApiState(response);
      if (this.disposed) return;
      this.acceptState(state);
      this.applyVisualState();
      this.publish({ loading: false, error: null });
    } catch (error) {
      if (!this.disposed) this.publish({ loading: false, error: String(error) });
    }
  }

  async removeImage(target: WallpaperTarget): Promise<void> {
    this.publish({ loading: true, error: null });
    try {
      await this.flushPersist();
      const state = await readApiState(await fetch(`${API_BASE}/image?region=${target}`, { method: 'DELETE' }));
      if (this.disposed) return;
      this.acceptState(state);
      this.applyVisualState();
      this.publish({ loading: false, error: null });
    } catch (error) {
      if (!this.disposed) this.publish({ loading: false, error: String(error) });
    }
  }

  clearError(): void {
    if (this.snapshot.error !== null) this.publish({ error: null });
  }

  private async restoreState(): Promise<void> {
    try {
      const state = await readApiState(
        await fetch(`${API_BASE}/state`, { method: 'GET', cache: 'no-store' }),
      );
      if (this.disposed) return;
      this.acceptState(state);
      this.applyVisualState();
      this.publish({ loading: false, error: null });
    } catch (error) {
      if (!this.disposed) {
        this.applyVisualState();
        this.publish({ loading: false, error: `读取已保存的壁纸失败：${String(error)}` });
      }
    }
  }

  private acceptState(state: ApiState): void {
    this.settings = state.settings;
    this.imageUrl = state.imageUrl;
    this.regionImages = { settings: state.regionImages.settings.imageUrl, sidebar: state.regionImages.sidebar.imageUrl };
  }

  private applyVisualState(): void {
    if (!this.mounted) return;
    const body = document.body;
    const active = this.settings.enabled && this.imageUrl !== null;
    const [r, g, b] = hexToRgb(this.settings.maskColor);
    const [layer1, layer2, layer3] = surfaceLayerAlphas(this.settings.surfaceOpacity);
    const style = modeStyle(this.settings.mode);
    const overscan = Math.ceil(this.settings.blur * 2);

    body.style.setProperty('--dsh-wallpaper-image-opacity', String(this.settings.imageOpacity));
    body.style.setProperty('--dsh-wallpaper-blur', `${this.settings.blur}px`);
    body.style.setProperty('--dsh-wallpaper-inset', `${-overscan}px`);
    body.style.setProperty('--dsh-wallpaper-mask-rgb', `${r} ${g} ${b}`);
    body.style.setProperty('--dsh-wallpaper-mask-opacity', String(this.settings.maskOpacity));
    body.style.setProperty('--dsh-wallpaper-surface-alpha-1', String(layer1));
    body.style.setProperty('--dsh-wallpaper-surface-alpha-2', String(layer2));
    body.style.setProperty('--dsh-wallpaper-surface-alpha-3', String(layer3));

    if (this.mediaLayer !== null) {
      this.mediaLayer.style.backgroundImage = this.imageUrl === null ? 'none' : cssUrl(this.imageUrl);
      this.mediaLayer.style.backgroundSize = style.size;
      this.mediaLayer.style.backgroundRepeat = style.repeat;
      this.mediaLayer.style.backgroundPosition = backgroundPositionWithOffset(
        this.settings.position,
        this.settings.offsetXPercent,
        this.settings.offsetYPercent,
      );
    }
    body.toggleAttribute(ACTIVE_ATTRIBUTE, active);
    for (const [name, value] of Object.entries(regionVariables(this.settings, this.imageUrl, this.regionImages))) body.style.setProperty(name, value);
    body.setAttribute(REGIONS_ATTRIBUTE, '');
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      void this.queuePersist(this.settings);
    }, SETTINGS_DEBOUNCE_MS);
  }

  private flushPersist(): Promise<void> {
    if (this.persistTimer !== null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
      return this.queuePersist(this.settings);
    }
    return this.persistTail;
  }

  private queuePersist(settings: WallpaperSettings): Promise<void> {
    const payload = JSON.stringify(settings);
    const persist = async (): Promise<void> => {
      try {
        await readApiState(
          await fetch(`${API_BASE}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          }),
        );
      } catch (error) {
        if (!this.disposed) this.publish({ error: `保存设置失败：${String(error)}` });
      }
    };
    const next = this.persistTail.then(persist, persist);
    this.persistTail = next;
    return next;
  }

  private publish(patch: Partial<Pick<WallpaperSnapshot, 'loading' | 'error'>> = {}): void {
    this.snapshot = {
      settings: this.settings,
      hasImage: this.imageUrl !== null,
      previewUrl: this.imageUrl,
      regionImages: this.regionImages,
      panelOpen: this.panelOpen,
      loading: patch.loading ?? this.snapshot.loading,
      error: patch.error === undefined ? this.snapshot.error : patch.error,
    };
    for (const listener of this.listeners) listener();
  }
}

interface WallpaperPageRuntime {
  buildToken: object;
  controller: WallpaperController;
}

/**
 * Keep the body-level wallpaper independent from Cordis fiber churn.
 *
 * Client HMR can rebuild a settings-related fiber without replacing this
 * bundle. Reusing the page-owned controller keeps the media/mask layers and
 * body variables intact. When the wallpaper bundle itself changes, its new
 * factory receives a new build token and performs one explicit handoff.
 */
function pageController(): WallpaperController {
  const page = globalThis as typeof globalThis & {
    [PAGE_RUNTIME_KEY]?: WallpaperPageRuntime;
  };
  const current = page[PAGE_RUNTIME_KEY];
  if (current?.buildToken === CLIENT_BUILD_TOKEN) return current.controller;

  current?.controller.dispose();
  const controller = new WallpaperController();
  page[PAGE_RUNTIME_KEY] = { buildToken: CLIENT_BUILD_TOKEN, controller };
  return controller;
}

interface RangeFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange(value: number): void;
}

function RangeField(props: RangeFieldProps): React.ReactElement {
  return (
    <label className="dsh-wallpaper-field">
      <span className="dsh-wallpaper-field-label">
        <span>{props.label}</span>
        <span className="dsh-wallpaper-field-output">{props.display}</span>
      </span>
      <div className="dsh-wallpaper-range-row">
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          onChange={(event) => props.onChange(Number(event.currentTarget.value))}
        />
        <span className="dsh-wallpaper-number">{props.display}</span>
      </div>
    </label>
  );
}

interface WallpaperSelectOption<T extends string> {
  value: T;
  label: string;
}

function WallpaperSelect<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: T;
  options: ReadonlyArray<WallpaperSelectOption<T>>;
  onChange(value: T): void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;
  const items = React.useMemo<readonly MenuItem[]>(
    () => options.map((option) => ({ id: option.value, label: option.label })),
    [options],
  );

  return (
    <Menu
      className="dsh-wallpaper-select-menu"
      open={open}
      portal
      items={items}
      selectedId={value}
      onClose={() => setOpen(false)}
      onSelect={(id) => {
        onChange(id as T);
        setOpen(false);
      }}
      anchor={(
        <button
          type="button"
          className="dsh-wallpaper-select-trigger"
          aria-label={`${ariaLabel}，当前：${selectedLabel}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span>{selectedLabel}</span>
          <IconChevronDownOutline14 size={16} />
        </button>
      )}
    />
  );
}

interface PercentOffsetFieldProps {
  label: string;
  value: number;
  onChange(value: number): void;
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function PercentOffsetField(props: PercentOffsetFieldProps): React.ReactElement {
  return (
    <label className="dsh-wallpaper-field">
      <span className="dsh-wallpaper-field-label">
        <span>{props.label}</span>
        <span className="dsh-wallpaper-field-output">{formatPercent(props.value)}</span>
      </span>
      <div className="dsh-wallpaper-range-row dsh-wallpaper-offset-row">
        <input
          type="range"
          min={-100}
          max={100}
          step={0.5}
          value={props.value}
          onChange={(event) => props.onChange(Number(event.currentTarget.value))}
        />
        <input
          className="dsh-wallpaper-number-input"
          type="number"
          min={-100}
          max={100}
          step={0.5}
          value={props.value}
          onChange={(event) => {
            const value = event.currentTarget.valueAsNumber;
            if (Number.isFinite(value)) props.onChange(value);
          }}
          aria-label={`${props.label}（窗口百分比）`}
        />
      </div>
    </label>
  );
}

function WallpaperSettingsSection({ controller }: { controller: WallpaperController }): React.ReactElement {
  const snapshot = React.useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [target, setTarget] = React.useState<WallpaperTarget>('global');
  const settings = target === 'global' ? snapshot.settings : snapshot.settings.regions[target];
  const source = target === 'global' ? 'custom' : snapshot.settings.regions[target].source;
  const ownUrl = target === 'global' ? snapshot.previewUrl : snapshot.regionImages[target];
  const previewUrl = source === 'global' ? snapshot.previewUrl : ownUrl;
  const hasImage = ownUrl !== null;
  const displayName = source === 'global' ? snapshot.settings.imageName : settings.imageName;
  const update = (patch: Partial<WallpaperSurfaceSettings>): void => {
    if (target === 'global') controller.update(patch);
    else controller.updateRegion(target, patch);
  };
  const fileRef = React.useRef<HTMLInputElement>(null);
  const mode = MODE_OPTIONS.find((option) => option.value === settings.mode) ?? MODE_OPTIONS[0];

  const chooseImage = (): void => {
    controller.clearError();
    fileRef.current?.click();
  };

  return (
    <div className="dsh-wallpaper-settings" data-wallpaper-target={target}>
      <div className="dsh-wallpaper-targets" role="group" aria-label="背景调整区域">
        {([['global', '主界面'], ['settings', '设置面板'], ['sidebar', '右侧 Sidebar']] as const).map(([value, label]) => (
          <button type="button" key={value} aria-pressed={target === value} onClick={() => setTarget(value)}>{label}</button>
        ))}
      </div>
      <fieldset className="dsh-wallpaper-controls" disabled={snapshot.loading}>
        {target === 'global' ? null : (
          <div className="dsh-wallpaper-region-source">
            <WallpaperSelect
              ariaLabel="背景来源"
              value={source}
              options={[
                { value: 'none', label: '不使用壁纸（默认）' },
                { value: 'custom', label: '使用独立图片' },
                { value: 'global', label: '使用主界面图片' },
              ]}
              onChange={(source) => controller.updateRegion(target, { source })}
            />
            <p className="dsh-wallpaper-source-hint">只调整{target === 'settings' ? '应用设置弹窗' : '右侧 Sidebar（包括分栏和全屏）'}，不影响其他区域。</p>
          </div>
        )}
        <section className="dsh-wallpaper-card">
          <div className="dsh-wallpaper-source">
            <div
              className="dsh-wallpaper-preview"
              data-empty={previewUrl === null ? true : undefined}
              style={
                previewUrl === null
                  ? undefined
                  : {
                      backgroundImage: cssUrl(previewUrl),
                      backgroundSize: modeStyle(settings.mode).size,
                      backgroundRepeat: modeStyle(settings.mode).repeat,
                      backgroundPosition: settings.position,
                    }
              }
            >
              {previewUrl === null ? '尚未选择图片' : null}
            </div>
            <div className="dsh-wallpaper-source-copy">
              <div className="dsh-wallpaper-source-name">
                {snapshot.loading ? '正在读取图片…' : displayName ?? '选择一张本机图片'}
              </div>
              <p className="dsh-wallpaper-source-hint">
                原图保存在 Harness 数据目录中，不会上传到外部网络。
              </p>
              <div className="dsh-wallpaper-actions">
                <button
                  type="button"
                  className="dsh-wallpaper-button"
                  disabled={snapshot.loading}
                  onClick={chooseImage}
                >
                  {target === 'global' ? hasImage ? '更换图片' : '选择图片' : hasImage ? '更换独立图片' : '选择独立图片'}
                </button>
                {hasImage && source !== 'global' ? (
                  <button
                    type="button"
                    className="dsh-wallpaper-button"
                    data-danger
                    disabled={snapshot.loading}
                    onClick={() => void controller.removeImage(target)}
                  >
                    移除
                  </button>
                ) : null}
              </div>
              <input
                ref={fileRef}
                className="dsh-wallpaper-file"
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  if (file !== undefined) void controller.setImage(file, target);
                }}
              />
            </div>
          </div>

          {snapshot.error === null ? null : (
            <div className="dsh-wallpaper-error" role="alert">
              {snapshot.error}
            </div>
          )}

          {target === 'global' ? <div className="dsh-wallpaper-enable">
            <div className="dsh-wallpaper-enable-copy">
              <div className="dsh-wallpaper-enable-title">启用主界面壁纸</div>
              <div className="dsh-wallpaper-enable-hint">关闭后保留图片和所有设置。</div>
            </div>
            <label className="dsh-wallpaper-switch">
              <input
                type="checkbox"
                checked={snapshot.settings.enabled && hasImage}
                disabled={!hasImage || snapshot.loading}
                onChange={(event) => update({ enabled: event.currentTarget.checked })}
                aria-label="启用主界面壁纸"
              />
              <span />
            </label>
          </div> : null}
        </section>

        <section className="dsh-wallpaper-section">
          <div className="dsh-wallpaper-section-head">
            <h4 className="dsh-wallpaper-section-title">图片布局</h4>
            <span className="dsh-wallpaper-section-note">{mode.hint}</span>
          </div>
          <div className="dsh-wallpaper-grid">
            <div className="dsh-wallpaper-field">
              <span className="dsh-wallpaper-field-label">适应模式</span>
              <WallpaperSelect
                ariaLabel="适应模式"
                value={settings.mode}
                options={MODE_OPTIONS}
                onChange={(mode) => update({ mode })}
              />
            </div>
            <div className="dsh-wallpaper-field">
              <span className="dsh-wallpaper-field-label">图片位置</span>
              <WallpaperSelect
                ariaLabel="图片位置"
                value={settings.position}
                options={POSITION_OPTIONS}
                onChange={(position) => update({ position })}
              />
            </div>
            <PercentOffsetField
              label="横向偏移"
              value={settings.offsetXPercent}
              onChange={(offsetXPercent) => update({ offsetXPercent })}
            />
            <PercentOffsetField
              label="纵向偏移"
              value={settings.offsetYPercent}
              onChange={(offsetYPercent) => update({ offsetYPercent })}
            />
          </div>
        </section>

        <section className="dsh-wallpaper-section">
          <div className="dsh-wallpaper-section-head">
            <h4 className="dsh-wallpaper-section-title">图片效果</h4>
            <span className="dsh-wallpaper-section-note">实时预览</span>
          </div>
          <div className="dsh-wallpaper-grid">
            <RangeField
              label="图片不透明度"
              min={0}
              max={1}
              step={0.01}
              value={settings.imageOpacity}
              display={`${Math.round(settings.imageOpacity * 100)}%`}
              onChange={(imageOpacity) => update({ imageOpacity })}
            />
            <RangeField
              label="背景模糊"
              min={0}
              max={40}
              step={1}
              value={settings.blur}
              display={`${Math.round(settings.blur)}px`}
              onChange={(blur) => update({ blur })}
            />
          </div>
        </section>

        <section className="dsh-wallpaper-section">
          <div className="dsh-wallpaper-section-head">
            <h4 className="dsh-wallpaper-section-title">遮罩与界面</h4>
            <span className="dsh-wallpaper-section-note">保持文字可读性</span>
          </div>
          <div className="dsh-wallpaper-grid">
            <label className="dsh-wallpaper-field">
              <span className="dsh-wallpaper-field-label">
                <span>遮罩颜色</span>
                <span className="dsh-wallpaper-field-output">{settings.maskColor}</span>
              </span>
              <div className="dsh-wallpaper-color-row">
                <input
                  className="dsh-wallpaper-color"
                  type="color"
                  value={settings.maskColor}
                  onChange={(event) => update({ maskColor: event.currentTarget.value })}
                  aria-label="遮罩颜色"
                />
                <span className="dsh-wallpaper-source-hint" style={{ margin: 0 }}>
                  图片上方的统一颜色层
                </span>
              </div>
            </label>
            <RangeField
              label="遮罩强度"
              min={0}
              max={0.9}
              step={0.01}
              value={settings.maskOpacity}
              display={`${Math.round(settings.maskOpacity * 100)}%`}
              onChange={(maskOpacity) => update({ maskOpacity })}
            />
            {target === 'global' ? <RangeField
              label="界面填充"
              min={0}
              max={0.95}
              step={0.01}
              value={settings.surfaceOpacity}
              display={`${Math.round(settings.surfaceOpacity * 100)}%`}
              onChange={(surfaceOpacity) => update({ surfaceOpacity })}
            /> : <RangeField
              label="背景不透明度"
              min={0}
              max={100}
              step={1}
              value={Math.round(settings.surfaceOpacity * 100)}
              display={`${Math.round(settings.surfaceOpacity * 100)}%`}
              onChange={(opacity) => update({ surfaceOpacity: opacity / 100 })}
            />}
          </div>
        </section>

        <footer className="dsh-wallpaper-footer">
          <span className="dsh-wallpaper-storage-note">
            模糊只作用于背景图片，不会改变文字、菜单或弹窗的定位。
          </span>
          <button type="button" className="dsh-wallpaper-button" onClick={() => controller.resetAppearance(target)}>
            恢复默认效果
          </button>
        </footer>
      </fieldset>
    </div>
  );
}

interface PanelPosition {
  x: number;
  y: number;
}

function defaultPanelPosition(): PanelPosition {
  return {
    x: Math.max(PANEL_MARGIN, window.innerWidth - 480 - 24),
    y: Math.min(84, Math.max(PANEL_MARGIN, window.innerHeight - 240)),
  };
}

function readPanelPosition(): PanelPosition {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PANEL_POSITION_KEY) ?? 'null') as Partial<PanelPosition> | null;
    if (saved !== null && typeof saved.x === 'number' && typeof saved.y === 'number'
      && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      return { x: saved.x, y: saved.y };
    }
  } catch {
    // 损坏或不可用的 localStorage 不应影响壁纸本身。
  }
  return defaultPanelPosition();
}

function savePanelPosition(position: PanelPosition): void {
  try {
    window.localStorage.setItem(PANEL_POSITION_KEY, JSON.stringify(position));
  } catch {
    // 面板位置只是本机界面偏好，保存失败时静默回退到默认位置。
  }
}

function clampPanelPosition(position: PanelPosition, panel: HTMLElement | null): PanelPosition {
  const width = panel?.offsetWidth ?? Math.min(480, Math.max(0, window.innerWidth - PANEL_MARGIN * 2));
  const height = panel?.offsetHeight ?? Math.min(760, Math.max(0, window.innerHeight - PANEL_MARGIN * 2));
  const maxX = Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN);
  const maxY = Math.max(PANEL_MARGIN, window.innerHeight - height - PANEL_MARGIN);
  return {
    x: Math.round(Math.min(maxX, Math.max(PANEL_MARGIN, position.x))),
    y: Math.round(Math.min(maxY, Math.max(PANEL_MARGIN, position.y))),
  };
}

function samePanelPosition(left: PanelPosition, right: PanelPosition): boolean {
  return left.x === right.x && left.y === right.y;
}

function WallpaperFloatingPanel({ controller }: { controller: WallpaperController }): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const panelRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  } | null>(null);
  const [position, setPosition] = React.useState<PanelPosition>(readPanelPosition);

  React.useLayoutEffect(() => {
    if (!snapshot.panelOpen) return;
    setPosition((current) => {
      const next = clampPanelPosition(current, panelRef.current);
      return samePanelPosition(current, next) ? current : next;
    });
  }, [snapshot.panelOpen]);

  React.useEffect(() => {
    savePanelPosition(position);
  }, [position]);

  React.useEffect(() => {
    if (!snapshot.panelOpen) return;
    const handleResize = (): void => {
      setPosition((current) => {
        const next = clampPanelPosition(current, panelRef.current);
        return samePanelPosition(current, next) ? current : next;
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [snapshot.panelOpen]);

  if (!snapshot.panelOpen) return null;

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest('button, input, select, textarea, a')) return;
    const rect = panelRef.current?.getBoundingClientRect();
    const start = clampPanelPosition(
      rect === undefined ? position : { x: rect.left, y: rect.top },
      panelRef.current,
    );
    setPosition(start);
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      x: start.x,
      y: start.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    setPosition(
      clampPanelPosition(
        {
          x: drag.x + event.clientX - drag.clientX,
          y: drag.y + event.clientY - drag.clientY,
        },
        panelRef.current,
      ),
    );
  };

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={panelRef}
      className="dsh-wallpaper-floating"
      role="dialog"
      aria-modal="false"
      aria-label="图片壁纸设置"
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          controller.closePanel();
        }
      }}
    >
      <div
        className="dsh-wallpaper-floating-header"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        <div className="dsh-wallpaper-floating-heading">
          <h3 className="dsh-wallpaper-floating-title">图片壁纸</h3>
          <p className="dsh-wallpaper-floating-subtitle">拖动标题栏移动 · 调整时可直接查看主界面效果</p>
        </div>
        <button
          type="button"
          className="dsh-wallpaper-close"
          onClick={() => controller.closePanel()}
          aria-label="关闭壁纸设置"
          title="关闭"
        >
          <IconCloseOutline16 size={14} />
        </button>
      </div>
      <div className="dsh-wallpaper-floating-body">
        <WallpaperSettingsSection controller={controller} />
      </div>
    </div>
  );
}

function WallpaperSettingsLauncher({
  controller,
  close,
}: {
  controller: WallpaperController;
  close: () => void;
}): React.ReactElement {
  const launched = React.useRef(false);
  React.useEffect(() => {
    if (launched.current) return;
    launched.current = true;
    controller.openPanel();
    close();
  }, [close, controller]);
  return <div className="dsh-wallpaper-launcher">正在打开图片壁纸面板…</div>;
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(installStyles, 'dsh-wallpaper: client styles');
  const controller = pageController();
  ctx.effect(() => {
    controller.mount();
  }, 'dsh-wallpaper.page-background');

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'wallpaper',
        order: 35,
        label: '壁纸',
      },
      (props: { close: () => void }) => (
        <WallpaperSettingsLauncher controller={controller} close={props.close} />
      ),
    ),
  );
}
