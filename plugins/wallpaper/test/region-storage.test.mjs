import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import test from 'node:test';

test('upload, settings persistence and deletion keep the three image stores independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dfy-wallpaper-regions-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    const routes = [];
    const { apply } = await import('../lib/index.js');
    apply({ webServer: { register: route => routes.push(route) } });
    async function request(path, method = 'GET', body = '', headers = {}) {
      const route = routes.find(route => route.path === path.split('?')[0]);
      const req = Object.assign(Readable.from([Buffer.from(body)]), { url: path, method, headers });
      const chunks = [];
      let status;
      const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });
      res.writeHead = value => { status = value; };
      const done = once(res, 'finish');
      await route.handler(req, res);
      await done;
      return { status, body: Buffer.concat(chunks).toString() };
    }
    let state = JSON.parse((await request('/api/dsh-wallpaper/state')).body);
    assert.equal(state.settings.regions.settings.source, 'none');
    assert.equal(state.settings.regions.sidebar.source, 'none');
    for (const target of ['global', 'settings', 'sidebar']) {
      const response = await request(`/api/dsh-wallpaper/image?region=${target}`, 'PUT', `${target}-image`, {
        'content-type': 'image/png', 'x-dsh-wallpaper-filename': `${target}.png`,
      });
      assert.equal(response.status, 200);
      state = JSON.parse(response.body);
    }
    assert.equal(state.settings.imageName, 'global.png');
    assert.equal(state.settings.regions.settings.imageName, 'settings.png');
    assert.equal(state.settings.regions.sidebar.source, 'custom');
    const config = { ...state.settings, regions: {
      ...state.settings.regions, settings: { ...state.settings.regions.settings, blur: 19, imageName: 'forged.png' },
    } };
    assert.equal((await request('/api/dsh-wallpaper/settings', 'PUT', JSON.stringify(config))).status, 200);
    const stored = JSON.parse(await readFile(join(root, 'storages/dfy-plugins/wallpaper/config.json'), 'utf8'));
    assert.equal(stored.settings.regions.settings.imageName, 'settings.png');
    assert.equal(stored.settings.regions.settings.blur, 19);
    assert.equal(stored.settings.regions.sidebar.blur, 8);
    assert.equal((await request('/api/dsh-wallpaper/image?region=../current')).status, 400);
    assert.equal((await request('/api/dsh-wallpaper/image?region=settings', 'DELETE')).status, 200);
    assert.equal((await request('/api/dsh-wallpaper/image?region=settings')).status, 404);
    assert.equal((await request('/api/dsh-wallpaper/image?region=sidebar')).body, 'sidebar-image');
    assert.equal((await request('/api/dsh-wallpaper/image')).body, 'global-image');
    state = JSON.parse((await request('/api/dsh-wallpaper/state')).body);
    assert.equal(state.settings.regions.settings.source, 'none');
    assert.equal(state.regionImages.sidebar.hasImage, true);
    await request('/api/dsh-wallpaper/image', 'DELETE');
    state = JSON.parse((await request('/api/dsh-wallpaper/state')).body);
    assert.equal(state.hasImage, false);
    assert.equal(state.regionImages.sidebar.hasImage, true);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
