import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSettings, wallpaperTarget } from '../lib/logic.js';
import { regionVariables } from '../lib/regions.js';

test('region fill remains adjustable without a wallpaper, independently of global fill', () => {
  const settings = normalizeSettings({ imageName: 'global.png', surfaceOpacity: 0.1, regions: {
    settings: { source: 'none', surfaceOpacity: 0 },
    sidebar: { source: 'none', surfaceOpacity: 0.4 },
  } });
  const css = regionVariables(settings, '/global', { settings: '/settings', sidebar: '/sidebar' });
  for (const region of ['settings', 'sidebar']) {
    assert.equal(css[`--dsh-wallpaper-${region}-image`], 'none');
    assert.equal(css[`--dsh-wallpaper-${region}-mask-opacity`], '0');
  }
  assert.equal(css['--dsh-wallpaper-settings-surface-1'], '0');
  assert.equal(css['--dsh-wallpaper-sidebar-surface-1'], '0.4');
});

test('different images and effects stay scoped, with explicit global reuse and missing-image fallback', () => {
  const settings = normalizeSettings({ regions: {
    settings: { source: 'custom', imageOpacity: 0.2, blur: 12 },
    sidebar: { source: 'custom', imageOpacity: 0.8, blur: 2 },
  } });
  let css = regionVariables(settings, '/global', { settings: '/settings', sidebar: '/sidebar' });
  assert.equal(css['--dsh-wallpaper-settings-image'], 'url("/settings")');
  assert.equal(css['--dsh-wallpaper-sidebar-image'], 'url("/sidebar")');
  assert.equal(css['--dsh-wallpaper-settings-opacity'], '0.2');
  assert.equal(css['--dsh-wallpaper-sidebar-blur'], '2px');
  settings.regions.sidebar.source = 'global';
  css = regionVariables(settings, '/global', { settings: null, sidebar: '/sidebar' });
  assert.equal(css['--dsh-wallpaper-sidebar-image'], 'url("/global")');
  assert.equal(css['--dsh-wallpaper-settings-image'], 'none');
  assert.equal(css['--dsh-wallpaper-settings-surface-1'], '0.95');
});

test('fill changes leave independently selected image opacity and blur unchanged', () => {
  const settings = normalizeSettings({ regions: {
    settings: { source: 'custom', surfaceOpacity: 0, imageOpacity: 0.3, blur: 5 },
    sidebar: { source: 'custom', surfaceOpacity: 0.95, imageOpacity: 0.7, blur: 12 },
  } });
  const css = regionVariables(settings, '/global', { settings: '/settings', sidebar: '/sidebar' });
  assert.equal(css['--dsh-wallpaper-settings-surface-1'], '0');
  assert.equal(css['--dsh-wallpaper-sidebar-surface-1'], '0.95');
  assert.equal(css['--dsh-wallpaper-settings-opacity'], '0.3');
  assert.equal(css['--dsh-wallpaper-sidebar-blur'], '12px');
});

test('HTTP image targets cannot select arbitrary storage paths', () => {
  assert.equal(wallpaperTarget(null), 'global');
  for (const target of ['global', 'settings', 'sidebar']) assert.equal(wallpaperTarget(target), target);
  for (const target of ['', '../current', '/tmp/picture', 'SETTINGS']) assert.equal(wallpaperTarget(target), undefined);
});
