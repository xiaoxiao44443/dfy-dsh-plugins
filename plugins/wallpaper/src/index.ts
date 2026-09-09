/** dsh-wallpaper Host 半区：持久化设置、图片并提供同源 HTTP 接口。 */
import type { Context } from '@deepseek-ai/cordis';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { DEFAULT_SETTINGS, normalizeSettings, wallpaperTarget, type WallpaperRegion, type WallpaperSettings, type WallpaperTarget } from './logic.js';

export const name = 'wallpaper';
export const inject = ['webServer'];

const DATA_DIR = dshHomePath('storages', 'dfy-plugins', 'wallpaper');
const LEGACY_DATA_DIR = dshHomePath('storages', 'xiao443', 'dsh-wallpaper');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const IMAGE_FILE = join(DATA_DIR, 'assets', 'current');
const MAX_JSON_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

interface StoredImage {
  imageMime: string | null;
  imageVersion: number;
}

interface StoredConfig extends StoredImage {
  settings: WallpaperSettings;
  regionImages: Record<WallpaperRegion, StoredImage>;
}

interface ImageState {
  hasImage: boolean;
  imageUrl: string | null;
}

interface ClientState {
  settings: WallpaperSettings;
  hasImage: boolean;
  imageUrl: string | null;
  regionImages: Record<WallpaperRegion, ImageState>;
}

const DEFAULT_CONFIG: StoredConfig = {
  settings: { ...DEFAULT_SETTINGS },
  imageMime: null,
  imageVersion: 0,
  regionImages: { settings: { imageMime: null, imageVersion: 0 }, sidebar: { imageMime: null, imageVersion: 0 } },
};

function imageFile(target: WallpaperTarget): string {
  return target === 'global' ? IMAGE_FILE : join(DATA_DIR, 'assets', target, 'current');
}

function storedImage(value: unknown): StoredImage {
  const item = typeof value === 'object' && value !== null ? value as Partial<StoredImage> : {};
  return {
    imageMime: typeof item.imageMime === 'string' && /^image\/[a-z0-9.+-]+$/i.test(item.imageMime) ? item.imageMime : null,
    imageVersion: typeof item.imageVersion === 'number' && Number.isFinite(item.imageVersion) ? Math.max(0, Math.floor(item.imageVersion)) : 0,
  };
}

function withImage(config: StoredConfig, target: WallpaperTarget, image: StoredImage, imageName: string | null): StoredConfig {
  if (target === 'global') return {
    ...config, ...image,
    settings: normalizeSettings({ ...config.settings, enabled: imageName !== null, imageName }),
  };
  return {
    ...config,
    regionImages: { ...config.regionImages, [target]: image },
    settings: normalizeSettings({ ...config.settings, regions: {
      ...config.settings.regions,
      [target]: { ...config.settings.regions[target], imageName, source: imageName === null ? 'none' : 'custom' },
    } }),
  };
}

let storageReady: Promise<void> | undefined;

async function migrateLegacyStorage(): Promise<void> {
  try {
    await stat(DATA_DIR);
    return;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  await mkdir(dirname(DATA_DIR), { recursive: true, mode: 0o700 });
  try {
    await rename(LEGACY_DATA_DIR, DATA_DIR);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'ENOENT' && code !== 'EEXIST') throw error;
  }
}

function ensureStorageReady(): Promise<void> {
  storageReady ??= migrateLegacyStorage();
  return storageReady;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function readConfig(): Promise<StoredConfig> {
  await ensureStorageReady();
  try {
    const parsed = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as Partial<StoredConfig>;
    return {
      settings: normalizeSettings(parsed.settings),
      ...storedImage(parsed),
      regionImages: {
        settings: storedImage(parsed.regionImages?.settings),
        sidebar: storedImage(parsed.regionImages?.sidebar),
      },
    };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { ...DEFAULT_CONFIG, settings: { ...DEFAULT_SETTINGS } };
    throw error;
  }
}

async function writeConfig(config: StoredConfig): Promise<void> {
  await ensureStorageReady();
  await writeFileAtomic(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

async function imageExists(target: WallpaperTarget): Promise<boolean> {
  await ensureStorageReady();
  try {
    return (await stat(imageFile(target))).isFile();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function toClientState(config: StoredConfig): Promise<ClientState> {
  const state = async (target: WallpaperTarget): Promise<ImageState> => {
    const image = target === 'global' ? config : config.regionImages[target];
    const settings = target === 'global' ? config.settings : config.settings.regions[target];
    const hasImage = settings.imageName !== null && image.imageMime !== null && await imageExists(target);
    return { hasImage, imageUrl: hasImage ? `/api/dsh-wallpaper/image?region=${target}&v=${image.imageVersion}` : null };
  };
  const [global, settingsImage, sidebarImage] = await Promise.all([state('global'), state('settings'), state('sidebar')]);
  const { hasImage } = global;
  const settings = hasImage
    ? config.settings
    : normalizeSettings({ ...config.settings, enabled: false, imageName: null });
  return {
    settings,
    ...global,
    regionImages: { settings: settingsImage, sidebar: sidebarImage },
  };
}

function sendJson(res: Parameters<WebRoute['handler']>[1], status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req: Parameters<WebRoute['handler']>[0], limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        settled = true;
        chunks.length = 0;
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

function decodeFileName(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return 'wallpaper';
  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded.length > 0 ? decoded.slice(0, 260) : 'wallpaper';
  } catch {
    return 'wallpaper';
  }
}

async function writeImageAtomic(content: Buffer, target: WallpaperTarget): Promise<void> {
  await ensureStorageReady();
  const file = imageFile(target);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function apply(ctx: Context): void {
  let mutationTail: Promise<void> = Promise.resolve();
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const stateRoute: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-wallpaper/state',
    async handler(req, res) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      try {
        sendJson(res, 200, await toClientState(await readConfig()));
      } catch (error) {
        sendJson(res, 500, { error: String(error) });
      }
    },
  };

  const settingsRoute: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-wallpaper/settings',
    async handler(req, res) {
      if (req.method !== 'PUT') return sendJson(res, 405, { error: 'method not allowed' });
      try {
        const body = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8')) as unknown;
        const state = await mutate(async () => {
          const current = await readConfig();
          const requested = normalizeSettings(body);
          const next: StoredConfig = {
            ...current,
            settings: { ...requested, imageName: current.settings.imageName, regions: {
              settings: { ...requested.regions.settings, imageName: current.settings.regions.settings.imageName },
              sidebar: { ...requested.regions.sidebar, imageName: current.settings.regions.sidebar.imageName },
            } },
          };
          await writeConfig(next);
          return toClientState(next);
        });
        sendJson(res, 200, await state);
      } catch (error) {
        sendJson(res, 400, { error: String(error) });
      }
    },
  };

  const imageRoute: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-wallpaper/image',
    async handler(req, res) {
      const target = wallpaperTarget(new URL(req.url ?? '/api/dsh-wallpaper/image', 'http://localhost').searchParams.get('region'));
      if (target === undefined) return sendJson(res, 400, { error: 'invalid wallpaper region' });
      if (req.method === 'GET') {
        try {
          const config = await readConfig();
          const image = target === 'global' ? config : config.regionImages[target];
          if (image.imageMime === null || !(await imageExists(target))) {
            sendJson(res, 404, { error: 'wallpaper not found' });
            return;
          }
          const info = await stat(imageFile(target));
          res.writeHead(200, {
            'content-type': image.imageMime,
            'content-length': info.size,
            'cache-control': 'private, max-age=31536000, immutable',
          });
          const stream = createReadStream(imageFile(target));
          stream.on('error', (error) => res.destroy(error));
          stream.pipe(res);
        } catch (error) {
          if (!res.headersSent) sendJson(res, 500, { error: String(error) });
        }
        return;
      }

      if (req.method === 'PUT') {
        try {
          const mime = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
          if (!/^image\/[a-z0-9.+-]+$/.test(mime)) {
            sendJson(res, 415, { error: 'content-type must be image/*' });
            return;
          }
          const content = await readBody(req, MAX_IMAGE_BYTES);
          if (content.length === 0) {
            sendJson(res, 400, { error: 'empty image' });
            return;
          }
          const state = await mutate(async () => {
            await writeImageAtomic(content, target);
            const current = await readConfig();
            const previous = target === 'global' ? current : current.regionImages[target];
            const next = withImage(current, target, {
              imageMime: mime,
              imageVersion: Math.max(Date.now(), previous.imageVersion + 1),
            }, decodeFileName(req.headers['x-dsh-wallpaper-filename']));
            await writeConfig(next);
            return toClientState(next);
          });
          sendJson(res, 200, await state);
        } catch (error) {
          sendJson(res, error instanceof Error && error.message === 'payload too large' ? 413 : 500, {
            error: String(error),
          });
        }
        return;
      }

      if (req.method === 'DELETE') {
        try {
          const state = await mutate(async () => {
            await rm(imageFile(target), { force: true });
            const current = await readConfig();
            const previous = target === 'global' ? current : current.regionImages[target];
            const next = withImage(current, target, {
              imageMime: null,
              imageVersion: Math.max(Date.now(), previous.imageVersion + 1),
            }, null);
            await writeConfig(next);
            return toClientState(next);
          });
          sendJson(res, 200, await state);
        } catch (error) {
          sendJson(res, 500, { error: String(error) });
        }
        return;
      }

      sendJson(res, 405, { error: 'method not allowed' });
    },
  };

  ctx.webServer.register(stateRoute);
  ctx.webServer.register(settingsRoute);
  ctx.webServer.register(imageRoute);
}
