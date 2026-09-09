import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backgroundPositionWithOffset,
  DEFAULT_SETTINGS,
  hexToRgb,
  modeStyle,
  normalizeSettings,
  surfaceLayerAlphas,
} from '../lib/logic.js';

test('normalizeSettings supplies defaults and clamps numeric controls', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(
    normalizeSettings({
      enabled: false,
      imageName: '  sea.png  ',
      mode: 'tile',
      position: 'right bottom',
      offsetXPercent: 9000,
      offsetYPercent: -9000,
      imageOpacity: 2,
      blur: -10,
      maskColor: '#AbC',
      maskOpacity: 4,
      surfaceOpacity: -1,
    }),
    {
      enabled: false,
      imageName: 'sea.png',
      regions: DEFAULT_SETTINGS.regions,
      mode: 'tile',
      position: 'right bottom',
      offsetXPercent: 100,
      offsetYPercent: -100,
      imageOpacity: 1,
      blur: 0,
      maskColor: '#aabbcc',
      maskOpacity: 0.9,
      surfaceOpacity: 0,
    },
  );
});

test('old settings leave both new regions plain and region controls normalize independently', () => {
  const old = normalizeSettings({ imageName: 'existing.png', imageOpacity: 0.8 });
  assert.equal(old.regions.settings.source, 'none');
  assert.equal(old.regions.sidebar.source, 'none');
  assert.equal(old.regions.settings.surfaceOpacity, 0.95);
  assert.equal(old.regions.sidebar.surfaceOpacity, 0.95);
  assert.equal(old.imageName, 'existing.png');
  const changed = normalizeSettings({ ...old, regions: {
    settings: { source: 'custom', imageName: 'settings.png', blur: 400, imageOpacity: -3, maskColor: '#abc' },
    sidebar: { source: 'global', blur: 3, imageOpacity: 0.7 },
  } });
  assert.equal(changed.imageOpacity, 0.8);
  assert.equal(changed.regions.settings.blur, 40);
  assert.equal(changed.regions.settings.imageOpacity, 0);
  assert.equal(changed.regions.settings.maskColor, '#aabbcc');
  assert.equal(changed.regions.sidebar.blur, 3);
  assert.equal(changed.regions.sidebar.imageOpacity, 0.7);
  assert.equal(old.regions.settings.blur, DEFAULT_SETTINGS.regions.settings.blur);
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(changed))), changed);
});

test('backgroundPositionWithOffset combines the anchor and viewport percentage tuning', () => {
  assert.equal(backgroundPositionWithOffset('center center', 0, 0), '50% 50%');
  assert.equal(
    backgroundPositionWithOffset('left bottom', 24, -12),
    'calc(0% + 24vw) calc(100% - 12vh)',
  );
  assert.equal(
    backgroundPositionWithOffset('right top', -8.5, 3),
    'calc(100% - 8.5vw) calc(0% + 3vh)',
  );
});

test('modeStyle maps every image adaptation mode to CSS background behavior', () => {
  assert.deepEqual(modeStyle('cover'), { size: 'cover', repeat: 'no-repeat' });
  assert.deepEqual(modeStyle('contain'), { size: 'contain', repeat: 'no-repeat' });
  assert.deepEqual(modeStyle('stretch'), { size: '100% 100%', repeat: 'no-repeat' });
  assert.deepEqual(modeStyle('fit-width'), { size: '100% auto', repeat: 'no-repeat' });
  assert.deepEqual(modeStyle('fit-height'), { size: 'auto 100%', repeat: 'no-repeat' });
  assert.deepEqual(modeStyle('center'), { size: 'auto', repeat: 'no-repeat' });
  assert.deepEqual(modeStyle('tile'), { size: 'auto', repeat: 'repeat' });
});

test('color and surface helpers produce safe CSS values', () => {
  assert.deepEqual(hexToRgb('#123abc'), [18, 58, 188]);
  assert.deepEqual(hexToRgb('invalid'), [0, 0, 0]);
  assert.deepEqual(surfaceLayerAlphas(0.5), [0.5, 0.6, 0.7]);
  assert.deepEqual(surfaceLayerAlphas(0.95), [0.95, 0.97, 0.99]);
  assert.deepEqual(surfaceLayerAlphas(1), [0.95, 0.97, 0.99]);
  assert.deepEqual(surfaceLayerAlphas(1, 1), [1, 1, 1]);
  const settings = normalizeSettings({ surfaceOpacity: 1, regions: {
    settings: { surfaceOpacity: 1 }, sidebar: { surfaceOpacity: 0 },
  } });
  assert.equal(settings.surfaceOpacity, 0.95);
  assert.equal(settings.regions.settings.surfaceOpacity, 1);
  assert.equal(settings.regions.sidebar.surfaceOpacity, 0);
});
