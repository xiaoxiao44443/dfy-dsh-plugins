/** @dfy-plugins/dsh-turn-guard Client half: settings page. */
import React from 'react';
import {
  normalizeTurnGuardSettings,
  type TurnGuardSettings,
} from './logic.js';

interface SettingsSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable';
  value: T | undefined;
  revision: number | undefined;
  writable: boolean;
}

interface SettingsScope<T> {
  getSnapshot(): SettingsSnapshot<T>;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<void>;
}

interface SlotEntryOptions {
  name: string;
  id?: string;
  order?: number;
  label?: string;
}

interface ClientCtx {
  effect(setup: () => (() => void), label: string): unknown;
  slots: {
    inject(name: string, register: () => (() => void) | Iterable<() => void>): () => void;
    register(options: SlotEntryOptions, component: unknown): () => void;
  };
  settingsScope: {
    bind<T>(spec: { namespace: string }): SettingsScope<T>;
  };
}

export const name = 'turn-guard';
export const inject = ['slots', 'settingsScope'];

const SETTINGS_NAMESPACE = 'dsh-turn-guard';
const STYLE_ID = '@dfy-plugins/dsh-turn-guard';

const STYLES = `
.dsh-turn-guard-root { padding: 0 4px 24px; color: inherit; }
.dsh-turn-guard-heading { margin: 0 0 6px; font-size: 17px; font-weight: 650; line-height: 24px; }
.dsh-turn-guard-intro { margin: 0 0 20px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-turn-guard-summary {
  display: flex; flex-wrap: wrap; gap: 7px; margin: -5px 0 20px;
}
.dsh-turn-guard-chip {
  padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-size: 11px; line-height: 16px;
}
.dsh-turn-guard-section + .dsh-turn-guard-section { margin-top: 20px; }
.dsh-turn-guard-section-title { margin: 0 2px 9px; font-size: 13px; font-weight: 650; line-height: 20px; }
.dsh-turn-guard-card {
  overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-3);
}
.dsh-turn-guard-row { display: flex; min-height: 58px; align-items: center; gap: 18px; padding: 12px 16px; }
.dsh-turn-guard-row + .dsh-turn-guard-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-turn-guard-copy { min-width: 0; flex: 1; }
.dsh-turn-guard-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 500; line-height: 22px; }
.dsh-turn-guard-description { margin-top: 2px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-turn-guard-switch { position: relative; width: 32px; height: 20px; flex: none; }
.dsh-turn-guard-switch input { position: absolute; opacity: 0; pointer-events: none; }
.dsh-turn-guard-switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.28)); transition: background .14s ease; }
.dsh-turn-guard-switch span::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: white; box-shadow: 0 1px 3px rgba(0,0,0,.16); transition: transform .14s ease; }
.dsh-turn-guard-switch input:checked + span { background: var(--dsw-alias-state-business-primary); }
.dsh-turn-guard-switch input:checked + span::after { transform: translateX(12px); }
.dsh-turn-guard-switch input:focus-visible + span { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.dsh-turn-guard-switch input:disabled + span { opacity: .48; }
.dsh-turn-guard-number {
  width: 70px; min-height: 32px; box-sizing: border-box; flex: none; padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 9px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px; text-align: right;
}
.dsh-turn-guard-number:focus { border-color: var(--dsw-alias-state-business-primary); outline: none; }
.dsh-turn-guard-number:disabled { opacity: .48; }
.dsh-turn-guard-unit { width: 24px; margin-left: -12px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-turn-guard-warning {
  margin: 12px 2px 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 17px;
}
.dsh-turn-guard-error { margin: 12px 2px 0; color: var(--dsw-alias-state-error-primary, #e5484d); font-size: 12px; line-height: 18px; }
@media (max-width: 520px) {
  .dsh-turn-guard-row { gap: 12px; padding: 11px 13px; }
  .dsh-turn-guard-description { max-width: 260px; }
}
`;

function installStyles(): () => void {
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin=${JSON.stringify(STYLE_ID)}]`);
  const tag = document.createElement('style');
  tag.dataset.plugin = STYLE_ID;
  tag.textContent = STYLES;
  if (existing === null) document.head.appendChild(tag);
  else existing.replaceWith(tag);
  return () => tag.remove();
}

function Switch({ checked, disabled, label, onChange }: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange(value: boolean): void;
}): React.ReactElement {
  return (
    <label className="dsh-turn-guard-switch">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span />
    </label>
  );
}

function NumberField({ value, min, max, unit, disabled, label, onCommit }: {
  value: number;
  min: number;
  max: number;
  unit: string;
  disabled: boolean;
  label: string;
  onCommit(value: number): void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState(String(value));
  React.useEffect(() => setDraft(String(value)), [value]);
  const commit = (): void => {
    const parsed = Number(draft);
    const next = Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : value;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <>
      <input
        className="dsh-turn-guard-number"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
      />
      <span className="dsh-turn-guard-unit">{unit}</span>
    </>
  );
}

function SettingsRow({ title, description, children }: {
  title: string;
  description: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="dsh-turn-guard-row">
      <div className="dsh-turn-guard-copy">
        <div className="dsh-turn-guard-title">{title}</div>
        <div className="dsh-turn-guard-description">{description}</div>
      </div>
      {children}
    </div>
  );
}

function TurnGuardPage({ scope }: { scope: SettingsScope<Partial<TurnGuardSettings>> }): React.ReactElement {
  const snapshot = React.useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  );
  const settings = normalizeTurnGuardSettings(snapshot.value);
  const writable = snapshot.status === 'ready' && snapshot.writable;
  const [error, setError] = React.useState<string | null>(null);
  const save = (field: keyof TurnGuardSettings, value: boolean | number): void => {
    setError(null);
    void scope.set(field, value).catch((cause: unknown) => setError(String(cause)));
  };

  return (
    <div className="dsh-turn-guard-root">
      <h3 className="dsh-turn-guard-heading">任务守卫</h3>
      <p className="dsh-turn-guard-intro">统一约束任务范围、证据门槛、失败恢复和完成条件；运行过久或反复尝试时提醒收敛，达到硬限制后停止当前回合。</p>
      <div className="dsh-turn-guard-summary" aria-label="当前保护摘要">
        <span className="dsh-turn-guard-chip">{settings.warningStep} 步提醒</span>
        <span className="dsh-turn-guard-chip">{settings.maxModelSteps} 步上限</span>
        <span className="dsh-turn-guard-chip">{settings.maxToolCalls} 次工具</span>
        <span className="dsh-turn-guard-chip">{settings.maxDurationMinutes} 分钟</span>
      </div>

      <section className="dsh-turn-guard-section">
        <h4 className="dsh-turn-guard-section-title">保护策略</h4>
        <div className="dsh-turn-guard-card">
          <SettingsRow title="启用任务守卫" description="只观察当前回合，不改写历史对话或工具结果。">
            <Switch checked={settings.enabled} disabled={!writable} label="启用任务守卫" onChange={(value) => save('enabled', value)} />
          </SettingsRow>
          <SettingsRow title="约束跑偏行为" description="保留用户原词，按明确任务意图选择技能，并压缩工具前的猜测与自我纠正。">
            <Switch checked={settings.behaviorGuidance} disabled={!writable || !settings.enabled} label="约束跑偏行为" onChange={(value) => save('behaviorGuidance', value)} />
          </SettingsRow>
          <SettingsRow title="达到上限时停止" description="先封锁后续工具并允许一次说明；若模型仍不收尾，再强制结束回合。关闭后只发送提醒。">
            <Switch checked={settings.hardStop} disabled={!writable || !settings.enabled} label="达到上限时停止" onChange={(value) => save('hardStop', value)} />
          </SettingsRow>
        </div>
      </section>

      <section className="dsh-turn-guard-section">
        <h4 className="dsh-turn-guard-section-title">单轮预算</h4>
        <div className="dsh-turn-guard-card">
          <SettingsRow title="提前提醒" description="达到该模型步数时，要求判断新证据并改变做法或结束。">
            <NumberField value={settings.warningStep} min={2} max={Math.max(2, settings.maxModelSteps - 1)} unit="步" disabled={!writable || !settings.enabled} label="提前提醒步数" onCommit={(value) => save('warningStep', value)} />
          </SettingsRow>
          <SettingsRow title="模型步数上限" description="限制模型→工具→模型的循环次数；普通问答通常只有 1–3 步。">
            <NumberField value={settings.maxModelSteps} min={4} max={200} unit="步" disabled={!writable || !settings.enabled} label="模型步数上限" onCommit={(value) => save('maxModelSteps', value)} />
          </SettingsRow>
          <SettingsRow title="工具调用上限" description="只统计模型直接发起的工具，工具内部的嵌套调用不重复计数。">
            <NumberField value={settings.maxToolCalls} min={8} max={500} unit="次" disabled={!writable || !settings.enabled} label="工具调用上限" onCommit={(value) => save('maxToolCalls', value)} />
          </SettingsRow>
          <SettingsRow title="运行时间上限" description="按当前回合首次模型步骤开始计时。">
            <NumberField value={settings.maxDurationMinutes} min={1} max={180} unit="分" disabled={!writable || !settings.enabled} label="运行时间上限" onCommit={(value) => save('maxDurationMinutes', value)} />
          </SettingsRow>
        </div>
      </section>

      <section className="dsh-turn-guard-section">
        <h4 className="dsh-turn-guard-section-title">重复检测</h4>
        <div className="dsh-turn-guard-card">
          <SettingsRow title="相同调用" description="相同工具与参数连续出现多少次后判定为重复。">
            <NumberField value={settings.repeatedCallLimit} min={2} max={20} unit="次" disabled={!writable || !settings.enabled} label="相同调用限制" onCommit={(value) => save('repeatedCallLimit', value)} />
          </SettingsRow>
          <SettingsRow title="相同失败" description="相同错误连续出现多少次后判定当前做法没有进展。">
            <NumberField value={settings.repeatedFailureLimit} min={2} max={20} unit="次" disabled={!writable || !settings.enabled} label="相同失败限制" onCommit={(value) => save('repeatedFailureLimit', value)} />
          </SettingsRow>
        </div>
        <p className="dsh-turn-guard-warning">守卫不会把“慢”本身当作失败；只有超过预算或出现可靠的重复信号时才介入。</p>
      </section>

      {error === null ? null : <p className="dsh-turn-guard-error">保存失败：{error}</p>}
      {snapshot.status === 'unavailable' ? <p className="dsh-turn-guard-error">当前部署未开放任务守卫设置。</p> : null}
    </div>
  );
}

export function apply(ctx: ClientCtx): void {
  const scope = ctx.settingsScope.bind<Partial<TurnGuardSettings>>({ namespace: SETTINGS_NAMESPACE });
  ctx.effect(installStyles, 'dsh-turn-guard: client styles');
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'turn-guard',
    order: 35,
    label: '任务守卫',
  }, () => <TurnGuardPage scope={scope} />));
}
