import type {} from '@deepseek-ai/cordis-plugin-loader';
/** DSH 0.1.7 live configuration and one-time import of DFY settings. */
import type { Context, Volatile } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-settings';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

export type LiveConfig<T> = { [K in keyof T]-?: Volatile<Exclude<T[K], undefined>> };

export function readLiveConfig<T>(config: LiveConfig<T>): T {
  return Object.fromEntries(Object.entries(config).map(([key, value]) =>
    [key, (value as Volatile<unknown>).get()])) as T;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Existing Profile overrides win; import only fields exposed by the new schema. */
export function legacySettingsPatch(legacy: unknown, current: unknown, values: unknown): Record<string, unknown> {
  const user = record(current);
  const fields = record(values);
  return Object.fromEntries(Object.entries(record(legacy)).filter(([key]) =>
    Object.hasOwn(fields, key) && !Object.hasOwn(user, key)));
}

export async function importLegacySettings(ctx: Context, entryId: string, namespace: string): Promise<void> {
  const profile = ctx.get('profileContext') as { home: string; dir: string } | undefined;
  if (profile === undefined) return;
  const marker = join(profile.dir, `.dfy-settings-${entryId}-v1.json`);
  try { await readFile(marker); return; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let legacy: unknown;
  // The official importer renames the old document; either source remains read-only here.
  for (const filename of ['settings.yaml.imported', 'settings.yaml']) {
    try {
      const document = record(parse(await readFile(join(profile.home, filename), 'utf8')));
      if (Object.hasOwn(document, namespace)) { legacy = document[namespace]; break; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (legacy === undefined) return;
  const descriptor = ctx.settings.describe().find(item => item.ns === entryId);
  if (descriptor === undefined) throw new Error(`DFY settings entry unavailable: ${entryId}`);
  const patch = legacySettingsPatch(legacy, descriptor.user, descriptor.value);
  if (Object.keys(patch).length > 0) await ctx.settings.update(entryId, patch, descriptor.revision);
  await mkdir(profile.dir, { recursive: true });
  await writeFile(marker, JSON.stringify({ version: 1, namespace, entryId }) + '\n', { mode: 0o600 });
}

export function configureSettings(ctx: Context, entryId: string, namespace: string): void {
  ctx.effect(() => ctx.settings.configure({ auto: false }), `${entryId}: custom settings`);
  let active = true;
  ctx.effect(() => () => { active = false; }, `${entryId}: settings migration lifetime`);
  // Do not await the loader in apply: the loader is waiting for this plugin itself.
  void (ctx.root.get('loader') as { await(): Promise<void> }).await().then(async () => { if (active) await importLegacySettings(ctx, entryId, namespace); })
    .catch(error => ctx.logger.error(`DFY settings migration failed for ${entryId}`, error));
}

export function watchLiveConfig(ctx: Context, listener: () => void): void {
  ctx.on('loader/volatile-update', listener);
}
