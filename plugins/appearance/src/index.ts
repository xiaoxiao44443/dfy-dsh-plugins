/** @dfy-plugins/dsh-appearance Host half: durable appearance preferences. */
import type { Context } from '@deepseek-ai/cordis';
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';

export const name = 'appearance';
export const inject = ['settings'];

export interface Config {
  collapseCompletedProcess?: boolean;
  chatFontSize?: number;
  chatLineHeightRatio?: number;
  processLineHeightRatio?: number;
}

export const Config: z<Config> = z.object({
  collapseCompletedProcess: z.boolean().default(true),
  chatFontSize: z.number().step(1).min(13).max(20).default(16),
  chatLineHeightRatio: z.number().step(0.05).min(1.35).max(1.9).default(1.65),
  processLineHeightRatio: z.number().step(0.05).min(1).max(1.9).default(1.4),
});

const SETTINGS_NS = 'dsh-appearance' as SettingsNamespace;

export function apply(ctx: Context, entryConfig: Config): void {
  ctx.settings.register(SETTINGS_NS, Config, { base: entryConfig });
}
