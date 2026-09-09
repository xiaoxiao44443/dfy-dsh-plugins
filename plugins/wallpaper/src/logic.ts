export const WALLPAPER_MODES = [
  'cover',
  'contain',
  'stretch',
  'fit-width',
  'fit-height',
  'center',
  'tile',
] as const;

export type WallpaperMode = (typeof WALLPAPER_MODES)[number];

export const WALLPAPER_POSITIONS = [
  'left top',
  'center top',
  'right top',
  'left center',
  'center center',
  'right center',
  'left bottom',
  'center bottom',
  'right bottom',
] as const;

export type WallpaperPosition = (typeof WALLPAPER_POSITIONS)[number];

export const WALLPAPER_REGIONS = ['settings', 'sidebar'] as const;
export type WallpaperRegion = (typeof WALLPAPER_REGIONS)[number];
export type WallpaperTarget = 'global' | WallpaperRegion;
export type WallpaperSource = 'none' | 'global' | 'custom';

export interface WallpaperSurfaceSettings {
  enabled: boolean;
  imageName: string | null;
  mode: WallpaperMode;
  position: WallpaperPosition;
  offsetXPercent: number;
  offsetYPercent: number;
  imageOpacity: number;
  blur: number;
  maskColor: string;
  maskOpacity: number;
  surfaceOpacity: number;
}

export interface WallpaperRegionSettings extends Omit<WallpaperSurfaceSettings, 'enabled'> {
  source: WallpaperSource;
}

export interface WallpaperSettings extends WallpaperSurfaceSettings {
  regions: Record<WallpaperRegion, WallpaperRegionSettings>;
}

const DEFAULT_SURFACE_SETTINGS: WallpaperSurfaceSettings = {
  enabled: true,
  imageName: null,
  mode: 'cover',
  position: 'center center',
  offsetXPercent: 0,
  offsetYPercent: 0,
  imageOpacity: 1,
  blur: 0,
  maskColor: '#000000',
  maskOpacity: 0.18,
  surfaceOpacity: 0.56,
};

export function defaultRegionSettings(): WallpaperRegionSettings {
  const { enabled: _enabled, ...appearance } = DEFAULT_SURFACE_SETTINGS;
  return { ...appearance, source: 'none', imageOpacity: 0.45, blur: 8, maskOpacity: 0, surfaceOpacity: 0.95 };
}

export const DEFAULT_SETTINGS: WallpaperSettings = {
  ...DEFAULT_SURFACE_SETTINGS,
  regions: { settings: defaultRegionSettings(), sidebar: defaultRegionSettings() },
};

export interface WallpaperModeStyle {
  size: string;
  repeat: 'no-repeat' | 'repeat';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function isMode(value: unknown): value is WallpaperMode {
  return typeof value === 'string' && (WALLPAPER_MODES as readonly string[]).includes(value);
}

function isPosition(value: unknown): value is WallpaperPosition {
  return typeof value === 'string' && (WALLPAPER_POSITIONS as readonly string[]).includes(value);
}

function normalizeHexColor(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.maskColor;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const [r, g, b] = trimmed.slice(1).split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return DEFAULT_SETTINGS.maskColor;
}

function normalizeSurface(value: unknown, maxSurfaceOpacity = 0.95): WallpaperSurfaceSettings {
  const input = isRecord(value) ? value : {};
  const rawName = typeof input.imageName === 'string' ? input.imageName.trim() : '';
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_SETTINGS.enabled,
    imageName: rawName.length > 0 ? rawName.slice(0, 260) : null,
    mode: isMode(input.mode) ? input.mode : DEFAULT_SETTINGS.mode,
    position: isPosition(input.position) ? input.position : DEFAULT_SETTINGS.position,
    offsetXPercent: clamp(input.offsetXPercent, DEFAULT_SETTINGS.offsetXPercent, -100, 100),
    offsetYPercent: clamp(input.offsetYPercent, DEFAULT_SETTINGS.offsetYPercent, -100, 100),
    imageOpacity: clamp(input.imageOpacity, DEFAULT_SETTINGS.imageOpacity, 0, 1),
    blur: clamp(input.blur, DEFAULT_SETTINGS.blur, 0, 40),
    maskColor: normalizeHexColor(input.maskColor),
    maskOpacity: clamp(input.maskOpacity, DEFAULT_SETTINGS.maskOpacity, 0, 0.9),
    surfaceOpacity: clamp(input.surfaceOpacity, DEFAULT_SETTINGS.surfaceOpacity, 0, maxSurfaceOpacity),
  };
}

export function normalizeSettings(value: unknown): WallpaperSettings {
  const input = isRecord(value) ? value : {};
  const regions = isRecord(input.regions) ? input.regions : {};
  const region = (key: WallpaperRegion): WallpaperRegionSettings => {
    const value = isRecord(regions[key]) ? regions[key] : {};
    const { enabled: _enabled, ...appearance } = normalizeSurface({ ...defaultRegionSettings(), ...value }, 1);
    return { ...appearance, source: value.source === 'global' || value.source === 'custom' ? value.source : 'none' };
  };
  return { ...normalizeSurface(input), regions: { settings: region('settings'), sidebar: region('sidebar') } };
}

/** Only these named image stores can be selected by an HTTP request. */
export function wallpaperTarget(value: string | null): WallpaperTarget | undefined {
  return value === null || value === 'global' ? 'global'
    : value === 'settings' || value === 'sidebar' ? value : undefined;
}

function offsetAxis(anchor: string, offset: number, viewportUnit: 'vw' | 'vh'): string {
  if (offset === 0) return anchor;
  const operator = offset < 0 ? '-' : '+';
  return `calc(${anchor} ${operator} ${Math.abs(offset)}${viewportUnit})`;
}

/** 把九宫格锚点与相对视口的百分比微调组合成 background-position。 */
export function backgroundPositionWithOffset(
  position: WallpaperPosition,
  offsetXPercent: number,
  offsetYPercent: number,
): string {
  const [horizontal, vertical] = position.split(' ') as [
    'left' | 'center' | 'right',
    'top' | 'center' | 'bottom',
  ];
  const horizontalAnchor = { left: '0%', center: '50%', right: '100%' }[horizontal];
  const verticalAnchor = { top: '0%', center: '50%', bottom: '100%' }[vertical];
  return `${offsetAxis(horizontalAnchor, offsetXPercent, 'vw')} ${offsetAxis(verticalAnchor, offsetYPercent, 'vh')}`;
}

export function modeStyle(mode: WallpaperMode): WallpaperModeStyle {
  switch (mode) {
    case 'contain':
      return { size: 'contain', repeat: 'no-repeat' };
    case 'stretch':
      return { size: '100% 100%', repeat: 'no-repeat' };
    case 'fit-width':
      return { size: '100% auto', repeat: 'no-repeat' };
    case 'fit-height':
      return { size: 'auto 100%', repeat: 'no-repeat' };
    case 'center':
      return { size: 'auto', repeat: 'no-repeat' };
    case 'tile':
      return { size: 'auto', repeat: 'repeat' };
    case 'cover':
    default:
      return { size: 'cover', repeat: 'no-repeat' };
  }
}

export function hexToRgb(value: string): [number, number, number] {
  const color = normalizeHexColor(value).slice(1);
  return [
    Number.parseInt(color.slice(0, 2), 16),
    Number.parseInt(color.slice(2, 4), 16),
    Number.parseInt(color.slice(4, 6), 16),
  ];
}

export function surfaceLayerAlphas(base: number, maxOpacity = 0.95): [number, number, number] {
  const normalized = clamp(base, DEFAULT_SETTINGS.surfaceOpacity, 0, maxOpacity);
  return [normalized, Math.max(normalized, Math.min(0.97, normalized + 0.1)), Math.max(normalized, Math.min(0.99, normalized + 0.2))];
}
