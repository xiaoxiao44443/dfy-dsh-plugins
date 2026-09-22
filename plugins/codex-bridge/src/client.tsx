/** DSH Client half: plugin-manager settings page for the local Codex bridge. */
import React from 'react';
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives';

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
.dsh-codex-settings { color: var(--dsw-alias-label-primary); }
.dsh-codex-field { display: flex; align-items: center; gap: 20px; padding: 12px 0 20px; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.dsh-codex-copy { min-width: 0; flex: 1; }
.dsh-codex-label { font-size: 13px; font-weight: 500; line-height: 1.5; }
.dsh-codex-hint { margin: 6px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; }
.dsh-codex-statuses { display: grid; gap: 12px; margin: 20px 0; }
.dsh-codex-status { display: flex; align-items: center; justify-content: space-between; gap: 20px; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.5; }
.dsh-codex-status strong { color: var(--dsw-alias-label-primary); font-weight: 500; }
.dsh-codex-dot { display: inline-block; width: 8px; height: 8px; margin-right: 7px; border-radius: 50%; background: var(--dsw-alias-label-caption); }
.dsh-codex-dot[data-state='ok'] { background: var(--dsw-alias-state-success-primary, #2bab75); }
.dsh-codex-dot[data-state='warn'] { background: var(--dsw-alias-state-warning-primary, #e7a530); }
.dsh-codex-actions { margin-top: 16px; }
.dsh-codex-message { margin: 12px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.dsh-codex-message[data-error] { color: var(--dsw-alias-state-error-primary); }
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

function BridgeSettingsPage({ scope }: { scope: SettingsScope<BridgeSettings> }): React.ReactElement {
  const snapshot = React.useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  );
  const [status, setStatus] = React.useState<BridgeStatus | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
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
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const toggle = (checked: boolean): void => {
    if (!writable || saving) return;
    setSaving(true);
    setSaveError(null);
    void scope.set('enabled', checked)
      .then((accepted) => {
        if (!accepted) throw new Error('设置未保存，请刷新后重试。');
        return refresh();
      })
      .catch((reason: unknown) => setSaveError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setSaving(false));
  };

  const bridgeLabel = !enabled ? '已关闭' : status?.running ? '正在监听本机' : '尚未启动';
  const connectionLabel = status?.mcpConnected ? 'Codex 已连接' : '等待新任务连接';

  if (snapshot.status !== 'ready') return <p className="dsh-codex-message" role="status">{snapshot.status === 'loading' ? '正在加载设置…' : '该插件当前未加载，暂时无法配置。'}</p>;

  return (
    <div className="dsh-codex-settings">
      {!writable ? <p className="dsh-codex-message" role="status">本部署的设置为只读。</p> : null}
      <div className="dsh-codex-field">
        <div className="dsh-codex-copy">
          <div className="dsh-codex-label">启用 Codex 连接</div>
          <p className="dsh-codex-hint">关闭后停止本机桥接；再次开启时会自动恢复监听。</p>
        </div>
        <Switch label="启用 Codex 连接" checked={enabled} disabled={!writable || saving} onChange={toggle} />
      </div>
      <div className="dsh-codex-statuses" aria-live="polite">
        <div className="dsh-codex-status"><span>本机桥接</span><strong><i className="dsh-codex-dot" data-state={status?.running ? 'ok' : 'warn'} />{status === null ? '正在检查…' : bridgeLabel}</strong></div>
        <div className="dsh-codex-status"><span>活动会话</span><strong>{status === null ? '—' : String(status.sessions)}</strong></div>
        <div className="dsh-codex-status"><span>MCP 状态</span><strong><i className="dsh-codex-dot" data-state={status?.mcpConnected ? 'ok' : undefined} />{status === null ? '正在检查…' : connectionLabel}</strong></div>
      </div>
      {status?.mcpConnected ? null : <p className="dsh-codex-hint">安装或更新 Codex 插件后，请新建一个 Codex 任务；已经打开的任务不会热加载插件或 MCP。</p>}
      <p className="dsh-codex-hint">桥接仅监听 127.0.0.1，并使用随机令牌鉴权。工具调用仍经过 Harness 原有的权限与策略检查。</p>
      {error === null ? null : <p className="dsh-codex-message" role="alert" data-error>{error}</p>}
      {saveError === null ? null : <p className="dsh-codex-message" role="alert" data-error>{saveError}</p>}
      <div className="dsh-codex-actions"><Button variant="outline" size="sm" disabled={saving} onClick={() => void refresh()}>刷新状态</Button></div>
    </div>
  );
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(installStyles, 'dsh-codex-bridge: client styles');
  const scope = ctx.configForms.get<BridgeSettings>('codex-bridge');
  // Standalone installs configure on their package page; the combined bundle
  // opens the same form from the component row. The manager owns navigation.
  const SettingsView = ({ view }: PluginConfigViewProps): React.ReactNode => view === 'summary'
    ? '让 Codex 使用当前 Harness 会话的工具和 Skills。'
    : <BridgeSettingsPage scope={scope} />;
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@dfy-plugins/dsh-codex-bridge',
  }, SettingsView));
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: '@dfy-plugins/dsh-bundle#codex-bridge',
  }, SettingsView));
}
