/** @dfy-plugins/dsh-visualize Client half: replayable interactive visualization rows. */
import React from 'react';
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import {
  IconChevronDownOutlineRegular,
  IconInspectOutlineRegular,
  IconSparkleRegular,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives';

import { parseVisualizationMeta, visualizationUrl, type VisualizationMeta } from './logic.js';

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
}

export const name = 'visualize';
export const inject = ['slots'];

const TOOL_NAME = 'dfy_visualize_render';
const STYLE_ID = '@dfy-plugins/dsh-visualize';
const MESSAGE_SOURCE = 'dsh-visualize';
const MIN_FRAME_HEIGHT = 180;
const MAX_FRAME_HEIGHT = 4096;

const STYLES = `
.dsh-visualize-tool { display: flex; min-width: 0; width: 100%; flex-direction: column; }
.dsh-visualize-row { position: relative; display: flex; min-width: 0; min-height: 1lh; align-items: center; overflow: hidden; }
.dsh-visualize-tool[data-state='running'] .dsh-visualize-row::after { position: absolute; inset: 0 auto 0 0; width: 300px; animation: dsh-visualize-sweep 2.6s ease-out infinite; background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%); content: ''; pointer-events: none; }
.dsh-visualize-leading { display: inline-flex; width: 16px; height: 16px; flex: none; align-items: center; justify-content: center; margin-right: 6px; color: var(--dsw-alias-label-tertiary); }
.dsh-visualize-title { flex: none; color: var(--dsw-alias-label-secondary); font-size: 14px; line-height: 24px; }
.dsh-visualize-separator { width: 2px; height: 2px; flex: none; margin: 0 8px; border-radius: 1px; background: var(--dsw-alias-label-caption); }
.dsh-visualize-toggle { display: flex; min-width: 0; max-width: 100%; min-height: 1lh; flex: 0 1 auto; appearance: none; align-items: center; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; }
.dsh-visualize-toggle:focus-visible, .dsh-visualize-inspect:focus-visible { border-radius: 4px; outline: 2px solid var(--dsw-alias-brand-primary, #298df8); outline-offset: -1px; }
.dsh-visualize-inspect { display: inline-flex; min-width: 0; min-height: 1lh; flex: none; appearance: none; align-items: center; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; }
button.dsh-visualize-inspect { cursor: pointer; }
.dsh-visualize-summary { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-tertiary); font-size: 14px; line-height: 24px; text-overflow: ellipsis; white-space: nowrap; }
.dsh-visualize-summary[data-error] { color: var(--dsw-alias-state-error-primary, #e5484d); }
.dsh-visualize-toggle:hover .dsh-visualize-summary { color: var(--dsw-alias-label-primary); }
.dsh-visualize-chevron { flex: none; margin-left: 4px; color: var(--dsw-alias-label-tertiary); opacity: 0; transform: rotate(-90deg); transition: opacity .12s ease, transform .16s ease; }
.dsh-visualize-toggle:hover .dsh-visualize-chevron { opacity: 1; }
.dsh-visualize-toggle[aria-expanded='true'] .dsh-visualize-chevron { opacity: 1; transform: rotate(0); }
.dsh-visualize-details { display: flex; flex-direction: column; }
.dsh-visualize-details[hidden], .dsh-visualize-panel[hidden] { display: none !important; }
.dsh-visualize-io-card { display: flex; flex-direction: column; margin: 4px 0 4px 4px; overflow: hidden; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-markdown-code-block); font: var(--dsw-font-markdown-code-block-small); }
.dsh-visualize-io-section { display: grid; max-height: 150px; grid-template-columns: max-content minmax(0, 1fr); align-items: baseline; column-gap: 14px; padding: 12px 16px; overflow: auto; }
.dsh-visualize-io-label { position: sticky; top: 0; align-self: start; color: var(--dsw-alias-label-caption); }
.dsh-visualize-io-text { min-width: 0; margin: 0; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
.dsh-visualize-io-text[data-error] { color: var(--dsw-alias-state-error-primary); }
.dsh-visualize-io-divider { height: 1px; flex: none; background: var(--dsw-alias-border-l2); }
.dsh-visualize-inspect-action { display: inline-flex; align-self: flex-start; align-items: center; gap: 4px; margin: 4px 0 2px 4px; padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 11px; line-height: 16px; }
.dsh-visualize-inspect-action:hover { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-primary); }
.dsh-visualize-panel { display: block; min-width: 0; max-width: calc(100% - 22px); margin: 8px 0 8px 22px; }
.dsh-visualize-frame { display: block; width: 100%; flex: none; border: 0; background: transparent; }
@keyframes dsh-visualize-sweep { 0% { left: -300px; } 90%, 100% { left: 100%; } }
@media (max-width: 680px) { .dsh-visualize-panel { max-width: 100%; margin-left: 0; } }
@media (prefers-reduced-motion: reduce) { .dsh-visualize-tool[data-state='running'] .dsh-visualize-row::after { display: none; animation: none; } .dsh-visualize-chevron { transition: none; } }
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

function firstLine(value: string): string {
  return value.split('\n', 1)[0] ?? value;
}

function resultText(block: ToolCallViewProps['block']): string | null {
  if (!('kind' in block)) return null;
  const parts = block.content.flatMap((item: unknown) => {
    if (typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text') {
      const text = (item as { text?: unknown }).text;
      return typeof text === 'string' ? [text] : [];
    }
    return [];
  });
  if (parts.length === 0 && block.error !== undefined) return `${block.error.name}: ${block.error.code}`;
  return parts.join('\n') || null;
}

function requestedTitle(block: ToolCallViewProps['block']): string | undefined {
  const raw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? '';
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const title = (value as { title?: unknown }).title;
    return typeof title === 'string' && title.trim().length > 0 ? title.trim().slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

function requestedFilePath(block: ToolCallViewProps['block']): string | undefined {
  const raw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? '';
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const filePath = (value as { file_path?: unknown }).file_path;
    return typeof filePath === 'string' && filePath.trim().length > 0 ? filePath.trim().slice(0, 1_000) : undefined;
  } catch {
    return undefined;
  }
}

function toolInput(block: ToolCallViewProps['block']): string | null {
  const raw = (('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? '').trim();
  if (raw.length === 0) return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function currentTheme(): 'light' | 'dark' {
  const root = document.documentElement;
  const declared = root.dataset.theme ?? root.getAttribute('data-color-scheme');
  if (declared === 'dark' || root.classList.contains('dark')) return 'dark';
  if (declared === 'light' || root.classList.contains('light')) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function VisualizationFrame({
  meta,
  sourceFile,
  visible,
}: {
  meta: VisualizationMeta;
  sourceFile?: string;
  visible: boolean;
}): React.ReactElement {
  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = React.useState(MIN_FRAME_HEIGHT);
  const [measured, setMeasured] = React.useState(false);
  const [scrollable, setScrollable] = React.useState(false);
  const src = visualizationUrl(meta);

  const sendTheme = React.useCallback((): void => {
    iframeRef.current?.contentWindow?.postMessage({ source: MESSAGE_SOURCE, type: 'theme', theme: currentTheme() }, '*');
  }, []);

  React.useEffect(() => {
    const receive = (event: MessageEvent): void => {
      const frame = iframeRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      const value = event.data as { source?: unknown; type?: unknown; artifactId?: unknown; height?: unknown } | null;
      if (value?.source !== MESSAGE_SOURCE || value.type !== 'resize' || value.artifactId !== meta.artifactId) return;
      if (typeof value.height !== 'number' || !Number.isFinite(value.height)) return;
      const measuredHeight = Math.ceil(value.height);
      const nextHeight = Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, measuredHeight));
      const nextScrollable = measuredHeight > MAX_FRAME_HEIGHT;
      setHeight(nextHeight);
      setScrollable(nextScrollable);
      setMeasured(true);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [meta.artifactId]);

  React.useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(sendTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-scheme'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', sendTheme);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', sendTheme);
    };
  }, [sendTheme]);

  return (
    <div
      className="dsh-visualize-panel"
      data-dsh-artifact-content="visualization"
      data-dsh-artifact-url={src}
      data-dsh-source-file={sourceFile}
      hidden={!visible}
    >
      <iframe
        ref={iframeRef}
        className="dsh-visualize-frame"
        src={src}
        title={meta.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        scrolling={scrollable ? 'auto' : 'no'}
        style={{
          height: `${String(height)}px`,
          opacity: measured ? 1 : 0,
          pointerEvents: measured ? 'auto' : 'none',
        }}
        onLoad={() => {
          sendTheme();
        }}
      />
    </div>
  );
}

function VisualizationToolRow({ block, inspect }: ToolCallViewProps): React.ReactElement {
  const settled = 'kind' in block;
  const stopped = settled && block.error?.code === 'interrupted';
  const state = !settled ? 'running' : stopped ? 'stopped' : block.isError ? 'error' : 'ok';
  const meta = settled && !block.isError ? parseVisualizationMeta(block.meta) : undefined;
  const pendingTitle = requestedTitle(block);
  const sourceFile = requestedFilePath(block);
  const input = toolInput(block);
  const output = resultText(block);
  const summary = state === 'running'
    ? pendingTitle === undefined ? '正在创建可视化' : `正在创建：${pendingTitle}`
    : state === 'error'
      ? firstLine(output ?? '可视化创建失败')
      : state === 'stopped'
        ? '已停止创建可视化'
        : meta === undefined ? '已创建可视化' : `已创建：${meta.title}`;
  const artifactKey = meta === undefined ? undefined : `${meta.sessionId}:${meta.artifactId}`;
  const [open, setOpen] = React.useState(meta !== undefined);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const detailsExpandable = input !== null || output !== null;
  const currentArtifact = React.useRef<string | undefined>(artifactKey);
  React.useEffect(() => {
    if (artifactKey === undefined || artifactKey === currentArtifact.current) return;
    currentArtifact.current = artifactKey;
    setOpen(true);
  }, [artifactKey]);

  const heading = (
    <>
      <span className="dsh-visualize-leading">
        {state === 'error' ? <StateDot state="error" /> : state === 'stopped' ? <StateDot state="warning" /> : <IconSparkleRegular size={14} />}
      </span>
      <span className="dsh-visualize-title">DFY VISUALIZE</span>
    </>
  );

  return (
    <div
      className="dsh-visualize-tool"
      data-state={state}
      data-tool={TOOL_NAME}
      data-dsh-visualization-output={meta === undefined ? undefined : ''}
    >
      <div className="dsh-visualize-row">
        {!detailsExpandable ? (
          <span className="dsh-visualize-inspect">{heading}</span>
        ) : (
          <button
            type="button"
            className="dsh-visualize-inspect"
            aria-label={`DFY VISUALIZE，${detailsOpen ? '收起参数' : '展开参数'}`}
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((value) => !value)}
          >
            {heading}
          </button>
        )}
        <span className="dsh-visualize-separator" aria-hidden />
        {meta === undefined ? (
          <span className="dsh-visualize-summary" data-error={state === 'error' || undefined}>{summary}</span>
        ) : (
          <button
            type="button"
            className="dsh-visualize-toggle"
            aria-label={`${summary}，${open ? '收起' : '展开'}`}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="dsh-visualize-summary">{summary}</span>
            <IconChevronDownOutlineRegular className="dsh-visualize-chevron" size={14} />
          </button>
        )}
      </div>
      <div className="dsh-visualize-details" hidden={!detailsOpen}>
          <div className="dsh-visualize-io-card">
            {input === null ? null : (
              <div className="dsh-visualize-io-section">
                <span className="dsh-visualize-io-label">IN</span>
                <pre className="dsh-visualize-io-text">{input}</pre>
              </div>
            )}
            {input === null || output === null ? null : <span className="dsh-visualize-io-divider" aria-hidden />}
            {output === null ? null : (
              <div className="dsh-visualize-io-section">
                <span className="dsh-visualize-io-label">OUT</span>
                <pre className="dsh-visualize-io-text" data-error={state === 'error' || undefined}>{output}</pre>
              </div>
            )}
          </div>
          {inspect === undefined ? null : (
            <button type="button" className="dsh-visualize-inspect-action" onClick={inspect}>
              <IconInspectOutlineRegular /> Inspect
            </button>
          )}
      </div>
      {meta !== undefined ? <VisualizationFrame key={artifactKey} meta={meta} sourceFile={sourceFile} visible={open} /> : null}
    </div>
  );
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(installStyles, 'dsh-visualize: client styles');
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: TOOL_NAME,
  }, VisualizationToolRow));
}
