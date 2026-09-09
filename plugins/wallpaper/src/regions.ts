import { backgroundPositionWithOffset, hexToRgb, modeStyle, surfaceLayerAlphas, WALLPAPER_REGIONS, type WallpaperRegion, type WallpaperSettings } from './logic.js';

export const REGIONS_ATTRIBUTE = 'data-dsh-wallpaper-regions';
export const REGION_SELECTORS: Record<WallpaperRegion, string> = {
  settings: '[role="dialog"][aria-modal="true"]:has([data-slot="settings.header"])',
  sidebar: '[data-sidebar-right-panel]',
};

const PROPERTIES = ['image', 'size', 'repeat', 'position', 'opacity', 'blur', 'mask-rgb', 'mask-opacity', 'surface-1', 'surface-2', 'surface-3'] as const;
export const REGION_VARIABLES = WALLPAPER_REGIONS.flatMap((region) => PROPERTIES.map((property) => `--dsh-wallpaper-${region}-${property}`));

export function regionVariables(settings: WallpaperSettings, globalUrl: string | null, images: Record<WallpaperRegion, string | null>): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const region of WALLPAPER_REGIONS) {
    const value = settings.regions[region];
    const url = value.source === 'custom' ? images[region] : value.source === 'global' ? globalUrl : null;
    const style = modeStyle(value.mode);
    const surfaces = surfaceLayerAlphas(value.surfaceOpacity, 1);
    const values = [
      url === null ? 'none' : `url(${JSON.stringify(url)})`, style.size, style.repeat,
      backgroundPositionWithOffset(value.position, value.offsetXPercent, value.offsetYPercent),
      String(value.imageOpacity), `${value.blur}px`, hexToRgb(value.maskColor).join(' '),
      String(url === null ? 0 : value.maskOpacity), ...surfaces.map(String),
    ];
    PROPERTIES.forEach((property, index) => { variables[`--dsh-wallpaper-${region}-${property}`] = values[index]!; });
  }
  return variables;
}

export const REGION_STYLES = `
body[${REGIONS_ATTRIBUTE}] { --dsh-wallpaper-region-rgb: 255 255 255; }
body[${REGIONS_ATTRIBUTE}][data-ds-dark-theme] { --dsh-wallpaper-region-rgb: 18 22 32; }
${WALLPAPER_REGIONS.map((region) => {
  const selector = `body[${REGIONS_ATTRIBUTE}] ${REGION_SELECTORS[region]}`;
  const variable = (name: string): string => `var(--dsh-wallpaper-${region}-${name})`;
  return `
${selector} {
  isolation: isolate;
  background: rgb(var(--dsh-wallpaper-region-rgb) / ${variable('surface-1')});
  --dsh-wallpaper-local-1: rgb(var(--dsh-wallpaper-region-rgb) / ${variable('surface-1')});
  --dsh-wallpaper-local-2: rgb(var(--dsh-wallpaper-region-rgb) / ${variable('surface-2')});
  --dsh-wallpaper-local-3: rgb(var(--dsh-wallpaper-region-rgb) / ${variable('surface-3')});
  --dsw-alias-bg-base: transparent;
  --dsw-specific-sidebar-fill: transparent;
  --dsw-alias-bg-layer-1: var(--dsh-wallpaper-local-1);
  --dsw-alias-bg-layer-2: var(--dsh-wallpaper-local-2);
  --dsw-alias-bg-layer-3: var(--dsh-wallpaper-local-3);
  --dsw-alias-bg-module-platform: var(--dsh-wallpaper-local-2);
  --dsw-specific-input-major: var(--dsh-wallpaper-local-2);
  --dsw-specific-selector: var(--dsh-wallpaper-local-2);
  --dsw-specific-tip: var(--dsh-wallpaper-local-2);
  --dsw-alias-button-elevated-fill: var(--dsh-wallpaper-local-2);
  --dsw-alias-button-floating-fill: var(--dsh-wallpaper-local-3);
  --dsw-alias-markdown-code-block: var(--dsh-wallpaper-local-2);
  --dsw-alias-markdown-code-block-banner: var(--dsh-wallpaper-local-3);
  --dsw-alias-markdown-inline-code: var(--dsh-wallpaper-local-2);
}
${selector}::before, ${selector}::after {
  content: ''; position: absolute; inset: 0; pointer-events: none; border-radius: inherit;
}
${selector}::before {
  z-index: -2;
  background-image: ${variable('image')};
  background-size: ${variable('size')};
  background-repeat: ${variable('repeat')};
  background-position: ${variable('position')};
  opacity: ${variable('opacity')};
  filter: blur(${variable('blur')});
  clip-path: inset(0);
}
${selector}::after {
  z-index: -1; background: rgb(${variable('mask-rgb')} / ${variable('mask-opacity')});
}`;
}).join('\n')}
`;
