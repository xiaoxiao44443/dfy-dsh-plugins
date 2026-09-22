/** DSH Client half: settings card for the local Codex bridge. */
import React from 'react';
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';

interface BridgeSettings {
  enabled?: boolean;
}

interface SettingsSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable';
  value: T | undefined;
  revision: number | undefined;
  writable: boolean;
}

interface SettingsScope<T> {
  getSnapshot(): SettingsSnapshot<T>;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
}

interface SlotEntryOptions {
  name: string;
  key?: string;
}

interface ClientCtx {
  effect(setup: () => (() => void), label: string): unknown;
  slots: {
    inject(name: string, register: () => unknown): unknown;
    register(options: SlotEntryOptions, component: unknown): unknown;
  };
  configForms: {
    get<T>(entryId: string): SettingsScope<T>;
  };
}

interface BridgeStatus {
  enabled: boolean;
  running: boolean;
  origin?: string;
  sessions: number;
  mcpConnected: boolean;
  lastMcpSeenAt?: number;
}

export const name = 'codex-bridge';
export const inject = ['slots', 'configForms'];

const STATUS_PATH = '/api/dsh-codex-bridge/status';
const STYLE_ID = '@dfy-plugins/dsh-codex-bridge';

const STYLES = `
.dsh-codex-card { overflow: hidden; list-style: none; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); border-radius: 12px; background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,.92)); color: var(--dsw-alias-label-primary, inherit); transition: border-color .16s, background .16s; }
.dsh-codex-card:hover, .dsh-codex-card[data-open] { border-color: var(--dsw-alias-label-dimmed, rgba(127,127,127,.42)); }
.dsh-codex-card[data-open] { background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.82)); }
.dsh-codex-head { display: flex; width: 100%; appearance: none; align-items: center; gap: 12px; padding: 14px 16px; border: 0; border-radius: 12px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dsh-codex-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #298df8); outline-offset: -2px; }
.dsh-codex-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 4px; }
.dsh-codex-title { color: var(--dsw-alias-label-primary, inherit); font-size: 15px; font-weight: 600; line-height: 1.4; }
.dsh-codex-description, .dsh-codex-hint { color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.86)); font-size: 13px; line-height: 1.5; }
.dsh-codex-badge { max-width: 220px; overflow: hidden; padding: 3px 9px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.1)); color: var(--dsw-alias-label-secondary, inherit); font-size: 12px; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }
.dsh-codex-chevron { flex: none; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.86)); transition: transform .16s; }
.dsh-codex-chevron[data-open] { transform: rotate(180deg); }
.dsh-codex-switch { position: relative; width: 32px; height: 20px; flex: none; }
.dsh-codex-switch input { position: absolute; opacity: 0; }
.dsh-codex-switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.18)); cursor: pointer; transition: background 120ms ease; }
.dsh-codex-switch span::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: white; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform 120ms ease; }
.dsh-codex-switch input:checked + span { background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #298df8)); }
.dsh-codex-switch input:checked + span::after { transform: translateX(12px); }
.dsh-codex-switch input:focus-visible + span { outline: 2px solid var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #298df8)); outline-offset: 2px; }
.dsh-codex-switch input:disabled + span { cursor: default; opacity: .6; }
.dsh-codex-body { margin: 0 16px; padding-bottom: 8px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); }
.dsh-codex-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.dsh-codex-field-head { display: flex; align-items: center; gap: 8px; }
.dsh-codex-label { min-width: 0; flex: 1; color: var(--dsw-alias-label-primary, inherit); font-size: 13px; font-weight: 500; line-height: 1.5; }
.dsh-codex-statuses { display: grid; gap: 9px; margin: 0 0 14px; }
.dsh-codex-status { display: flex; align-items: center; justify-content: space-between; gap: 20px; color: var(--dsw-alias-label-secondary, inherit); font-size: 13px; line-height: 1.5; }
.dsh-codex-status strong { color: var(--dsw-alias-label-primary, inherit); font-weight: 500; }
.dsh-codex-dot { display: inline-block; width: 8px; height: 8px; margin-right: 7px; border-radius: 50%; background: var(--dsw-alias-label-caption, #999); }
.dsh-codex-dot[data-state='ok'] { background: var(--dsw-alias-state-success-primary, #2bab75); }
.dsh-codex-dot[data-state='warn'] { background: var(--dsw-alias-state-warning-primary, #e7a530); }
.dsh-codex-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 0 4px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); }
.dsh-codex-button { appearance: none; padding: 5px 14px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); border-radius: 8px; background: none; color: var(--dsw-alias-label-secondary, inherit); font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; }
.dsh-codex-button:hover:not(:disabled) { border-color: var(--dsw-alias-label-dimmed, rgba(127,127,127,.42)); color: var(--dsw-alias-label-primary, inherit); }
.dsh-codex-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #298df8); outline-offset: 2px; }
.dsh-codex-button:disabled { cursor: default; opacity: .4; }
.dsh-codex-message { margin: 10px 0 0; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.86)); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.dsh-codex-message[data-error] { color: var(--dsw-alias-state-error-primary, #d93025); }
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

function BridgeCard({ scope }: { scope: SettingsScope<BridgeSettings> }): React.ReactElement {
  const snapshot = React.useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  );
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState<BridgeStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const enabled = snapshot.value?.enabled ?? true;
  const writable = snapshot.status === 'ready' && snapshot.writable;

  const refresh = React.useCallback(() => {
    return fetch(STATUS_PATH, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as BridgeStatus & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${String(response.status)}`);
        setStatus(body);
        setError(null);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  React.useEffect(() => {
    if (!open) return undefined;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  const toggle = (checked: boolean): void => {
    if (!writable || saving) return;
    setSaving(true);
    setError(null);
    void scope.set('enabled', checked)
      .then(() => refresh())
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setSaving(false));
  };

  const bridgeLabel = !enabled ? '已关闭' : status?.running ? '正在监听本机' : '尚未启动';
  const connectionLabel = status?.mcpConnected ? 'Codex 已连接' : '等待新任务连接';

  return (
    <li className="dsh-codex-card" data-open={open || undefined}>
      <button type="button" className="dsh-codex-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="dsh-codex-copy">
          <span className="dsh-codex-title">Codex 连接</span>
          <span className="dsh-codex-description">让 Codex 使用当前 Harness 会话的工具和 Skills。</span>
        </span>
        <span className="dsh-codex-badge">{enabled ? '已启用' : '已关闭'}</span>
        <IconChevronDownOutlineRegular className="dsh-codex-chevron" data-open={open || undefined} size={16} />
      </button>
      {open ? (
        <div className="dsh-codex-body">
          <div className="dsh-codex-field">
            <div className="dsh-codex-field-head">
              <div className="dsh-codex-label">启用 Codex 连接</div>
              <label className="dsh-codex-switch" title={enabled ? '关闭 Codex 连接' : '开启 Codex 连接'}>
                <input type="checkbox" checked={enabled} disabled={!writable || saving} onChange={(event) => toggle(event.target.checked)} />
                <span />
              </label>
            </div>
            <p className="dsh-codex-hint">关闭后停止本机桥接；再次开启时会自动恢复监听。</p>
          </div>
          <div className="dsh-codex-statuses">
            <div className="dsh-codex-status"><span>本机桥接</span><strong><i className="dsh-codex-dot" data-state={status?.running ? 'ok' : 'warn'} />{bridgeLabel}</strong></div>
            <div className="dsh-codex-status"><span>活动会话</span><strong>{String(status?.sessions ?? 0)}</strong></div>
            <div className="dsh-codex-status"><span>MCP 状态</span><strong><i className="dsh-codex-dot" data-state={status?.mcpConnected ? 'ok' : undefined} />{connectionLabel}</strong></div>
          </div>
          {status?.mcpConnected ? null : <p className="dsh-codex-hint">安装或更新 Codex 插件后，请新建一个 Codex 任务；已经打开的任务不会热加载插件或 MCP。</p>}
          <p className="dsh-codex-hint">桥接仅监听 127.0.0.1，并使用随机令牌鉴权。工具调用仍经过 Harness 原有的权限与策略检查。</p>
          {error === null ? null : <p className="dsh-codex-message" data-error>{error}</p>}
          {snapshot.status === 'unavailable' ? <p className="dsh-codex-message" data-error>当前部署未开放此插件的设置命名空间。</p> : null}
          <div className="dsh-codex-actions">
            <button type="button" className="dsh-codex-button" disabled={saving} onClick={() => void refresh()}>刷新状态</button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(installStyles, 'dsh-codex-bridge: client styles');
  const scope = ctx.configForms.get<BridgeSettings>('dsh-codex-bridge' );
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'dsh-codex-bridge',
  }, () => <BridgeCard scope={scope} />));
}
