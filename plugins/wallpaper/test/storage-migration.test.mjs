import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('wallpaper migrates the legacy directory without losing the original image name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dfy-wallpaper-migration-'));
  const previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  try {
    const legacy = join(root, 'storages', 'xiao443', 'dsh-wallpaper');
    const current = join(root, 'storages', 'dfy-plugins', 'wallpaper');
    await mkdir(join(legacy, 'assets'), { recursive: true });
    await writeFile(join(legacy, 'config.json'), `${JSON.stringify({
      settings: { enabled: true, imageName: '原图名.png' },
      imageMime: 'image/png',
      imageVersion: 7,
    })}\n`);
    await writeFile(join(legacy, 'assets', 'current'), 'image');

    const routes = [];
    const { apply } = await import('../lib/index.js');
    apply({ effect: setup => setup(), webServer: { register: (route) => routes.push(route) } });
    const stateRoute = routes.find((route) => route.path === '/api/dsh-wallpaper/state');
    assert.ok(stateRoute);
    let status;
    let response = '';
    await stateRoute.handler(
      { method: 'GET' },
      {
        writeHead: (next) => { status = next; },
        end: (chunk) => { response += String(chunk ?? ''); },
      },
    );

    assert.equal(status, 200);
    assert.equal(JSON.parse(response).settings.imageName, '原图名.png');
    assert.equal(JSON.parse(await readFile(join(current, 'config.json'), 'utf8')).settings.imageName, '原图名.png');
    await assert.rejects(access(legacy), { code: 'ENOENT' });
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    await rm(root, { recursive: true, force: true });
  }
});
