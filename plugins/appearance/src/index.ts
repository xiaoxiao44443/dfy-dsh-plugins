/** @dfy-plugins/dsh-appearance Host half: durable appearance preferences. */
import type { Context } from '@deepseek-ai/cordis';
import { configureSettings, type LiveConfig } from '@dfy-plugins/resource-core/settings';
import z from '@deepseek-ai/schemastery';

export const name = 'appearance';
export const inject = ['settings'];

interface Settings {
  collapseCompletedProcess?: boolean;
  chatFontSize?: number;
  chatLineHeightRatio?: number;
  processLineHeightRatio?: number;
}

export type Config = LiveConfig<Settings>;

export const Config = z.object({
  collapseCompletedProcess: z.boolean().default(true).volatile(),
  chatFontSize: z.number().step(1).min(13).max(20).default(16).volatile(),
  chatLineHeightRatio: z.number().step(0.05).min(1.35).max(1.9).default(1.65).volatile(),
  processLineHeightRatio: z.number().step(0.05).min(1).max(1.9).default(1.4).volatile(),
});

const SETTINGS_NS = 'dsh-appearance';

export function apply(ctx: Context, _entryConfig: Config): void {
  configureSettings(ctx, 'appearance', SETTINGS_NS);
}
