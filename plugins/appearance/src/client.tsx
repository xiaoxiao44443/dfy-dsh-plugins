/** @dfy-plugins/dsh-appearance Client half: settings page and completed-turn folding. */
import React from 'react';

import {
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CHAT_LINE_HEIGHT_RATIO,
  DEFAULT_PROCESS_LINE_HEIGHT_RATIO,
  MAX_CHAT_FONT_SIZE,
  MAX_CHAT_LINE_HEIGHT_RATIO,
  MAX_PROCESS_LINE_HEIGHT_RATIO,
  MIN_CHAT_FONT_SIZE,
  MIN_CHAT_LINE_HEIGHT_RATIO,
  MIN_PROCESS_LINE_HEIGHT_RATIO,
  customProcessFoldingEnabled,
  normalizeAppearanceSettings,
  planCompletedProcessSegments,
  processFoldingActivated,
  type AppearanceSettings,
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

interface OfficialChatSettings {
  transcriptView?: 'normal' | 'compact';
}

interface SlotEntryOptions {
  name: string;
  id?: string;
  order?: number;
  label?: string;
  priority?: number;
}

interface DesktopContextMenuContext {
  target: Element;
}

interface DesktopContextMenuService {
  register(contribution: {
    id: string;
    label: string;
    linkURL?: (context: DesktopContextMenuContext) => string;
    icon?: 'external-link' | 'folder';
    group?: string;
    order?: number;
    when(context: DesktopContextMenuContext): boolean;
    enabled(context: DesktopContextMenuContext): boolean;
    onSelect(context: DesktopContextMenuContext): void | Promise<void>;
  }): () => void;
}

interface SessionsService {
  list: {
    getSnapshot(): {
      current: string | undefined;
      byId: Record<string, { cwd?: string } | undefined>;
    };
  };
}

interface WorkspacesService {
  list: {
    getSnapshot(): {
      items: readonly { title: string; path: string }[];
    };
  };
  openPath(path: string): Promise<void>;
}

interface ClientCtx {
  desktopContextMenu?: DesktopContextMenuService;
  get?(name: string): unknown;
  inject(names: readonly string[], callback: (ctx: ClientCtx) => void): unknown;
  effect(setup: () => (() => void), label: string): unknown;
  slots: {
    inject(name: string, register: () => (() => void) | Iterable<() => void>): () => void;
    register(options: SlotEntryOptions, component: unknown): () => void;
  };
  settingsScope: {
    bind<T>(spec: { namespace: string }): SettingsScope<T>;
  };
}

export const name = 'appearance';
export const inject = ['slots', 'settingsScope'];

const STYLE_ID = '@dfy-plugins/dsh-appearance';
const BODY_ATTRIBUTE = 'data-dsh-appearance';
const SETTINGS_NAMESPACE = 'dsh-appearance';
const OFFICIAL_CHAT_SETTINGS_NAMESPACE = 'ui-chat';
const MEDIA_CONTENT = 'img, video, audio';
const IMAGE_PROCESS_CONTENT = 'img, [data-tool="dfy_vision_analyze"]';
const ARTIFACT_OUTPUT = '[data-dsh-visualization-output], [data-dsh-image-output]';
const ARTIFACT_CONTENT = '[data-dsh-artifact-content]';
const TYPOGRAPHY_SAVE_DEBOUNCE_MS = 250;
const REVEAL_FILE_PATH = '/api/dsh-desktop/shell/reveal';

function resolveWorkspacePath(cwd: string | undefined, path: string): string {
  if (/^(?:[a-z]:[\\/]|\\\\|\/)/iu.test(path)) return path;
  if (cwd === undefined || cwd.length === 0) return path;
  const base = cwd.replace(/[\\/]+$/u, '');
  const relative = path.replace(/^[\\/]+/u, '');
  return `${base}/${relative}`;
}

function fileLinkButton(target: Element): HTMLButtonElement | null {
  const button = target.closest('button');
  if (!(button instanceof HTMLButtonElement)) return null;
  const label = button.getAttribute('aria-label') ?? '';
  const text = button.textContent?.trim() ?? '';
  if (button.closest('[data-produced-files-row="true"]') !== null) return button;
  if (/^打开\s+/u.test(label)) return button;
  return button.closest('[data-disclosure-row]') !== null && /\.[a-z0-9]{1,16}$/iu.test(text)
    ? button
    : null;
}

function normalizedFileIdentity(value: unknown): string {
  return String(value ?? '').trim().replace(/^打开\s+/u, '').replaceAll('\\', '/').toLowerCase();
}

function visualizationLinkForFile(button: HTMLButtonElement | null): string {
  if (button === null) return '';
  const identity = normalizedFileIdentity(
    button.getAttribute('title') ?? button.getAttribute('aria-label') ?? button.textContent,
  );
  const basename = identity.split('/').at(-1) ?? identity;
  let scope = button.parentElement;
  while (scope !== null) {
    const candidates = [...scope.querySelectorAll<HTMLElement>('[data-dsh-artifact-url]')].flatMap((element) => {
      const rawUrl = element.dataset.dshArtifactUrl ?? '';
      let url: URL;
      try {
        url = new URL(rawUrl, document.baseURI);
      } catch {
        return [];
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];
      const source = normalizedFileIdentity(element.dataset.dshSourceFile);
      const sourceBasename = source.split('/').at(-1) ?? source;
      return [{ url: url.href, matches: source.length > 0 && (source === identity || sourceBasename === basename) }];
    });
    const matches = candidates.filter((candidate) => candidate.matches);
    if (matches.length === 1) return matches[0]!.url;
    if (matches.length === 0 && candidates.length === 1) return candidates[0]!.url;
    if (scope === document.body) break;
    scope = scope.parentElement;
  }
  return '';
}

function filePathForButton(button: HTMLButtonElement | null): string {
  if (button === null) return '';
  const title = button.getAttribute('title')?.trim() ?? '';
  if (title.length > 0) return title;
  const label = button.getAttribute('aria-label')?.trim() ?? '';
  const labeledPath = label.replace(/^(?:打开|open)\s+/iu, '').trim();
  return labeledPath !== label ? labeledPath : button.textContent?.trim() ?? '';
}

function isAbsoluteHostPath(path: string): boolean {
  return /^(?:[a-z]:[\\/]|\\\\[^\\]|\/)/iu.test(path);
}

function resolvedFilePath(ctx: ClientCtx, target: Element): string {
  const path = filePathForButton(fileLinkButton(target));
  if (path.length === 0) return '';
  const sessions = ctx.get?.('sessions') as SessionsService | undefined;
  const snapshot = sessions?.list.getSnapshot();
  const cwd = snapshot?.current === undefined ? undefined : snapshot.byId[snapshot.current]?.cwd;
  const resolved = resolveWorkspacePath(cwd, path);
  return isAbsoluteHostPath(resolved) ? resolved : '';
}

function workspacePathForTarget(ctx: ClientCtx, target: Element): string {
  const row = target.closest<HTMLElement>('[role="treeitem"][aria-expanded]');
  if (row === null) return '';
  const label = row.textContent?.trim() ?? '';
  if (label.length === 0) return '';
  const workspaces = ctx.get?.('workspaces') as WorkspacesService | undefined;
  const matches = workspaces?.list.getSnapshot().items.filter((workspace) => workspace.title === label) ?? [];
  return matches.length === 1 ? matches[0]!.path : '';
}

function revealFileLabel(): string {
  if (/mac/iu.test(navigator.platform)) return '在访达中显示';
  if (/win/iu.test(navigator.platform)) return '在资源管理器中显示';
  return '在文件管理器中显示';
}

async function revealFile(path: string): Promise<void> {
  const response = await fetch(REVEAL_FILE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (response.ok) return;
  const payload = await response.json().catch(() => ({})) as { message?: unknown };
  throw new Error(typeof payload.message === 'string' ? payload.message : `HTTP ${String(response.status)}`);
}

function installFileLinkContextMenu(ctx: ClientCtx): () => void {
  const service = ctx.desktopContextMenu
    ?? ctx.get?.('desktopContextMenu') as DesktopContextMenuService | undefined;
  if (service === undefined || typeof service.register !== 'function') return () => {};
  const disposers = [service.register({
    id: 'appearance.open-file',
    label: '打开文件',
    linkURL: (context) => visualizationLinkForFile(fileLinkButton(context.target)),
    icon: 'external-link',
    group: 'appearance-file-links',
    order: 0,
    when: (context) => fileLinkButton(context.target) !== null,
    enabled: (context) => fileLinkButton(context.target)?.disabled !== true,
    onSelect: (context) => { fileLinkButton(context.target)?.click(); },
  }), service.register({
    id: 'appearance.reveal-file',
    label: revealFileLabel(),
    icon: 'folder',
    group: 'appearance-file-links',
    order: 10,
    when: (context) => resolvedFilePath(ctx, context.target).length > 0,
    enabled: (context) => fileLinkButton(context.target)?.disabled !== true,
    onSelect: async (context) => { await revealFile(resolvedFilePath(ctx, context.target)); },
  }), service.register({
    id: 'appearance.open-workspace-folder',
    label: '打开文件夹',
    icon: 'folder',
    group: 'appearance-file-links',
    order: 20,
    when: (context) => workspacePathForTarget(ctx, context.target).length > 0,
    enabled: (context) => workspacePathForTarget(ctx, context.target).length > 0,
    onSelect: async (context) => {
      const workspaces = ctx.get?.('workspaces') as WorkspacesService | undefined;
      const path = workspacePathForTarget(ctx, context.target);
      if (workspaces !== undefined && path.length > 0) await workspaces.openPath(path);
    },
  })];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

const STYLES = `
body[${BODY_ATTRIBUTE}] {
  --dsh-appearance-chat-font-size: 16px;
  --dsh-appearance-chat-line-height: 28px;
  --dsh-appearance-process-font-size: 14px;
  --dsh-appearance-process-line-height: 20px;
}
body[${BODY_ATTRIBUTE}] [data-composer-card] [data-input-scroll]
  :is(textarea, [data-input-backdrop], [data-input-mirror]) {
  font-size: var(--dsh-appearance-chat-font-size) !important;
}
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='assistant-step'] > div,
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='assistant-step'] > div > div > :not([data-variant='think']) {
  font-size: var(--dsh-appearance-chat-font-size) !important;
  line-height: var(--dsh-appearance-chat-line-height) !important;
}
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='assistant-step']
  :is(p, li, blockquote, pre, code, table, td, th):not([data-variant='think'] *) {
  font-size: var(--dsh-appearance-chat-font-size) !important;
  line-height: var(--dsh-appearance-chat-line-height) !important;
}
body[${BODY_ATTRIBUTE}] :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])
  :is(
    .dsh-media-user-bubble,
    [data-time-hover-root] > div:first-child > [class*='_bubble'],
    [data-actions-reveal] > div:first-child > [class*='_bubble']
  ) {
  font-size: var(--dsh-appearance-chat-font-size) !important;
  line-height: var(--dsh-appearance-chat-line-height) !important;
}
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='assistant-step'] h1 { font-size: calc(var(--dsh-appearance-chat-font-size) + 12px) !important; line-height: calc(var(--dsh-appearance-chat-line-height) + 8px) !important; }
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='assistant-step'] h2 { font-size: calc(var(--dsh-appearance-chat-font-size) + 8px) !important; line-height: calc(var(--dsh-appearance-chat-line-height) + 6px) !important; }
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='assistant-step'] h3 { font-size: calc(var(--dsh-appearance-chat-font-size) + 4px) !important; line-height: calc(var(--dsh-appearance-chat-line-height) + 4px) !important; }
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='assistant-step'] h4 { font-size: calc(var(--dsh-appearance-chat-font-size) + 2px) !important; line-height: calc(var(--dsh-appearance-chat-line-height) + 2px) !important; }
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='assistant-step'] :is(h5, h6, td, th) { font-size: var(--dsh-appearance-chat-font-size) !important; line-height: var(--dsh-appearance-chat-line-height) !important; }
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='context'] :is(button, span),
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='assistant-step'] [data-variant='think'] :is(button, span, div),
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='tool-call'] [data-variant] :is(button, span),
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='tool-call'] [data-tool] :is(button, span),
body[${BODY_ATTRIBUTE}] [data-chat-flow-kind='command'] :is(button, span) {
  font-size: var(--dsh-appearance-process-font-size) !important;
  line-height: var(--dsh-appearance-process-line-height) !important;
}
body[${BODY_ATTRIBUTE}] :is(
  [data-chat-flow-kind='context'] [data-disclosure-row],
  [data-chat-flow-kind='assistant-step'] [data-variant='think'],
  [data-chat-flow-kind='assistant-step'] [data-variant='think'] [data-disclosure-row],
  [data-chat-flow-kind='tool-call'] [data-tool],
  [data-chat-flow-kind='tool-call'] [data-tool] > [role='button'],
  [data-chat-flow-kind='command'] [data-disclosure-row]
) {
  height: auto !important;
  min-height: var(--dsh-appearance-process-line-height) !important;
}
[data-dsh-appearance-process][data-dsh-appearance-collapsed='true'] {
  display: none !important;
}
[data-dsh-appearance-segment-think][data-dsh-appearance-collapsed='true'] {
  display: none !important;
}
.dsh-appearance-process-segment { min-width: 0; }
.dsh-appearance-artifacts {
  display: flex;
  min-width: 0;
  width: 100%;
  flex-direction: column;
  gap: 12px;
  margin: 10px 0 4px;
}
.dsh-appearance-artifacts .dsh-imagegen-tool-gallery { width: min(560px, 100%); margin: 0; }
.dsh-appearance-artifacts .dsh-visualize-panel { max-width: 100%; margin: 0; }
.dsh-appearance-process-toggle {
  display: flex;
  width: fit-content;
  max-width: 100%;
  min-width: 0;
  min-height: var(--dsh-appearance-process-line-height, 20px);
  appearance: none;
  align-items: center;
  gap: 6px;
  padding: 0 7px 0 3px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  font: inherit;
  font-size: var(--dsh-appearance-process-font-size, 14px);
  line-height: var(--dsh-appearance-process-line-height, 24px);
  text-align: left;
}
.dsh-appearance-process-toggle:hover { color: var(--dsw-alias-label-primary); }
.dsh-appearance-process-toggle:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.dsh-appearance-process-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-appearance-process-chevron { width: 14px; height: 14px; flex: none; margin-left: 1px; opacity: 0; transform: rotate(-90deg); transition: opacity .12s ease, transform .14s ease; }
.dsh-appearance-process-toggle:hover .dsh-appearance-process-chevron { opacity: 1; }
.dsh-appearance-process-toggle[aria-expanded='true'] .dsh-appearance-process-chevron { opacity: 1; transform: rotate(0); }
.dsh-appearance-reset { margin-top: 16px; }
.dsh-appearance-root { padding: 0 4px 24px; color: inherit; }
.dsh-appearance-heading { margin: 0 0 6px; font-size: 17px; font-weight: 650; line-height: 24px; }
.dsh-appearance-intro { margin: 0 0 20px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-appearance-section + .dsh-appearance-section { margin-top: 20px; }
.dsh-appearance-section-title { margin: 0 2px 9px; font-size: 13px; font-weight: 650; line-height: 20px; }
.dsh-appearance-card { overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-bg-layer-3); }
.dsh-appearance-row { display: flex; min-height: 58px; align-items: center; gap: 18px; padding: 12px 16px; }
.dsh-appearance-row + .dsh-appearance-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-appearance-copy { min-width: 0; flex: 1; }
.dsh-appearance-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 500; line-height: 22px; }
.dsh-appearance-description { margin-top: 2px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-appearance-switch { position: relative; width: 32px; height: 20px; flex: none; }
.dsh-appearance-switch input { position: absolute; opacity: 0; }
.dsh-appearance-switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.18)); cursor: pointer; transition: background 120ms ease; }
.dsh-appearance-switch span::after { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: white; box-shadow: 0 1px 2px rgba(0,0,0,.3); content: ''; transition: transform 120ms ease; }
.dsh-appearance-switch input:checked + span { background: var(--dsw-alias-state-business-primary); }
.dsh-appearance-switch input:checked + span::after { transform: translateX(12px); }
.dsh-appearance-switch input:focus-visible + span { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.dsh-appearance-switch input:disabled + span { cursor: default; opacity: .5; }
.dsh-appearance-size-control { display: grid; width: min(260px, 42%); flex: none; grid-template-columns: minmax(120px, 1fr) 42px; align-items: center; gap: 12px; }
.dsh-appearance-range { width: 100%; accent-color: var(--dsw-alias-state-business-primary); }
.dsh-appearance-size-value { color: var(--dsw-alias-label-secondary); font-size: 13px; font-variant-numeric: tabular-nums; text-align: right; }
.dsh-appearance-preview { padding: 16px; color: var(--dsw-alias-label-primary); line-height: 1.75; }
.dsh-appearance-preview-label { margin-bottom: 6px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 17px; }
.dsh-appearance-error { margin: 12px 2px 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
@media (max-width: 620px) {
  .dsh-appearance-row { align-items: flex-start; flex-direction: column; gap: 10px; }
  .dsh-appearance-switch { align-self: flex-end; margin-top: -42px; }
  .dsh-appearance-size-control { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-appearance-process-chevron, .dsh-appearance-switch span, .dsh-appearance-switch span::after { transition: none; }
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

function readSettings(scope: SettingsScope<Partial<AppearanceSettings>>): AppearanceSettings {
  return normalizeAppearanceSettings(scope.getSnapshot().value);
}

function applyTypography(fontSize: number, lineHeightRatio: number, processLineHeightRatio: number): void {
  const processSize = Math.max(13, fontSize - 2);
  const chatLineHeight = Math.round(fontSize * lineHeightRatio);
  const processLineHeight = Math.round(processSize * processLineHeightRatio);
  document.body.style.setProperty('--dsh-appearance-chat-font-size', `${String(fontSize)}px`);
  document.body.style.setProperty('--dsh-appearance-chat-line-height', `${String(chatLineHeight)}px`);
  document.body.style.setProperty('--dsh-appearance-process-font-size', `${String(processSize)}px`);
  document.body.style.setProperty('--dsh-appearance-process-line-height', `${String(processLineHeight)}px`);
}

function installPreferences(scope: SettingsScope<Partial<AppearanceSettings>>): () => void {
  const update = (): void => {
    document.body.setAttribute(BODY_ATTRIBUTE, '');
    const settings = readSettings(scope);
    applyTypography(settings.chatFontSize, settings.chatLineHeightRatio, settings.processLineHeightRatio);
  };
  update();
  const unsubscribe = scope.subscribe(update);
  return () => {
    unsubscribe();
    document.body.removeAttribute(BODY_ATTRIBUTE);
    document.body.style.removeProperty('--dsh-appearance-chat-font-size');
    document.body.style.removeProperty('--dsh-appearance-chat-line-height');
    document.body.style.removeProperty('--dsh-appearance-process-font-size');
    document.body.style.removeProperty('--dsh-appearance-process-line-height');
  };
}

/**
 * Alpha.1 introduced a whole-Turn Compact disclosure. Appearance owns a
 * finer per-response disclosure, so disable Compact whenever that disclosure
 * is enabled (including its initial enabled state). Older Harness versions
 * expose no ui-chat namespace and keep the existing behavior. A later explicit
 * user choice is not fought until the plugin disclosure is toggled off and on.
 */
function installOfficialTranscriptCompatibility(
  appearanceScope: SettingsScope<Partial<AppearanceSettings>>,
  officialScope: SettingsScope<OfficialChatSettings>,
): () => void {
  let disposed = false;
  let previouslyEnabled: boolean | undefined;
  let pendingEnable = false;
  let writing = false;
  const reconcile = (): void => {
    if (disposed) return;
    const appearanceSnapshot = appearanceScope.getSnapshot();
    if (appearanceSnapshot.status !== 'ready') return;
    const enabled = normalizeAppearanceSettings(
      appearanceSnapshot.value,
    ).collapseCompletedProcess;
    if (previouslyEnabled === undefined || enabled !== previouslyEnabled) {
      pendingEnable = processFoldingActivated(previouslyEnabled, enabled);
      previouslyEnabled = enabled;
    }
    if (!pendingEnable || writing) return;

    const officialSnapshot = officialScope.getSnapshot();
    if (officialSnapshot.status === 'loading') return;
    if (officialSnapshot.value?.transcriptView !== 'compact') {
      pendingEnable = false;
      return;
    }
    if (!officialSnapshot.writable) return;
    pendingEnable = false;
    writing = true;
    void officialScope.set('transcriptView', 'normal')
      .catch((cause: unknown) => {
        console.warn('[appearance] failed to disable the built-in Compact transcript', cause);
      })
      .finally(() => {
        writing = false;
        reconcile();
      });
  };
  const unsubscribers = [
    appearanceScope.subscribe(reconcile),
    officialScope.subscribe(reconcile),
  ];
  reconcile();
  return () => {
    disposed = true;
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

function flowRowsBefore(tail: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  let current = tail.previousElementSibling;
  while (current instanceof HTMLElement) {
    const kind = current.dataset.chatFlowKind;
    if (kind === 'user' || kind === 'turn-tail') break;
    if (kind !== undefined) rows.unshift(current);
    current = current.previousElementSibling;
  }
  return rows;
}

function removeFlowMarkers(rows: readonly HTMLElement[]): void {
  for (const row of rows) {
    row.removeAttribute('data-dsh-appearance-process');
    row.removeAttribute('data-dsh-appearance-segment-think');
    row.removeAttribute('data-dsh-appearance-collapsed');
  }
}

function flowNodeHasOutput(row: HTMLElement): boolean {
  if (row.dataset.chatFlowKind === 'assistant-step') {
    const copy = row.cloneNode(true) as HTMLElement;
    for (const reasoning of copy.querySelectorAll('[data-variant="think"]')) reasoning.remove();
    return (copy.textContent ?? '').trim().length > 0 || copy.querySelector(MEDIA_CONTENT) !== null;
  }
  return false;
}

function flowNodeHasArtifact(row: HTMLElement): boolean {
  return row.dataset.chatFlowKind === 'tool-call'
    && row.querySelector(ARTIFACT_OUTPUT) !== null;
}

interface ArtifactPromotion {
  outputRow: HTMLElement;
  artifactRows: readonly HTMLElement[];
  host: HTMLElement;
  dispose(): void;
}

function sameElements(left: readonly HTMLElement[], right: readonly HTMLElement[]): boolean {
  return left.length === right.length && left.every((element, index) => element === right[index]);
}

function installArtifactPromotion(
  turnId: number,
  segmentId: number,
  outputRow: HTMLElement,
  artifactRows: readonly HTMLElement[],
): ArtifactPromotion | undefined {
  const contents = artifactRows.flatMap((row) => [...row.querySelectorAll<HTMLElement>(ARTIFACT_CONTENT)]);
  if (contents.length === 0) return undefined;
  const host = document.createElement('div');
  host.className = 'dsh-appearance-artifacts';
  host.dataset.dshAppearanceArtifacts = `${String(turnId)}:${String(segmentId)}`;
  outputRow.after(host);
  const moved = contents.map((content) => {
    const placeholder = document.createComment('dsh-artifact-content');
    content.before(placeholder);
    host.append(content);
    return { content, placeholder };
  });
  return {
    outputRow,
    artifactRows: [...artifactRows],
    host,
    dispose() {
      for (const { content, placeholder } of moved) {
        if (placeholder.isConnected) placeholder.before(content);
        else content.remove();
        placeholder.remove();
      }
      host.remove();
    },
  };
}

function reconcileArtifactPromotion(
  promotions: Map<string, ArtifactPromotion>,
  desired: Set<string>,
  turnId: number,
  segmentId: number,
  outputRow: HTMLElement,
  artifactRows: readonly HTMLElement[],
): void {
  const marker = `${String(turnId)}:${String(segmentId)}`;
  desired.add(marker);
  const current = promotions.get(marker);
  if (current !== undefined
    && current.host.isConnected
    && current.outputRow === outputRow
    && sameElements(current.artifactRows, artifactRows)) return;
  current?.dispose();
  const next = installArtifactPromotion(turnId, segmentId, outputRow, artifactRows);
  if (next === undefined) promotions.delete(marker);
  else promotions.set(marker, next);
}

function segmentSummary(
  processRows: readonly HTMLElement[],
  outputReasoning: readonly HTMLElement[],
  toolCount: number,
  contextCount: number,
): string {
  const reasoning = outputReasoning.length + processRows.reduce(
    (total, row) => total + row.querySelectorAll('[data-variant="think"]').length,
    0,
  );
  const media = processRows.filter((row) => row.querySelector(IMAGE_PROCESS_CONTENT) !== null).length;
  const details = [
    ...(reasoning === 0 ? [] : [`思考了 ${String(reasoning)} 次`]),
    ...(contextCount === 0 ? [] : [`读取了 ${String(contextCount)} 项上下文`]),
    ...(toolCount === 0 ? [] : [`运行了 ${String(toolCount)} 个工具`]),
    ...(media === 0 ? [] : [`查看了 ${String(media)} 张图片`]),
  ];
  return details.length === 0 ? '查看过程' : details.join('、');
}

/** Exact vector used by DSH's Think disclosure (`IconChevronDownOutline14`). */
function createDisclosureChevron(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('fill', 'none');
  svg.classList.add('dsh-appearance-process-chevron');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z');
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  return svg;
}

function installSegmentDisclosure(
  turnId: number,
  segmentId: number,
  outputRow: HTMLElement,
  processRows: readonly HTMLElement[],
  toolCount: number,
  contextCount: number,
): () => void {
  const outputReasoning = [...outputRow.querySelectorAll<HTMLElement>('[data-variant="think"]')];
  if (processRows.length === 0 && outputReasoning.length === 0) return () => {};
  const marker = `${String(turnId)}:${String(segmentId)}`;
  const host = document.createElement('div');
  host.className = 'dsh-appearance-process-segment';
  host.dataset.dshAppearanceSegment = marker;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dsh-appearance-process-toggle';
  const label = document.createElement('span');
  label.className = 'dsh-appearance-process-label';
  const chevron = createDisclosureChevron();
  button.append(label, chevron);
  host.append(button);
  (processRows[0] ?? outputRow).before(host);
  let expanded = false;
  const update = (): void => {
    const collapsed = String(!expanded);
    for (const row of processRows) {
      row.dataset.dshAppearanceProcess = marker;
      row.dataset.dshAppearanceCollapsed = collapsed;
    }
    for (const reasoning of outputReasoning) {
      reasoning.dataset.dshAppearanceSegmentThink = marker;
      reasoning.dataset.dshAppearanceCollapsed = collapsed;
    }
    button.setAttribute('aria-expanded', String(expanded));
    label.textContent = segmentSummary(processRows, outputReasoning, toolCount, contextCount);
  };
  const toggle = (): void => { expanded = !expanded; update(); };
  button.addEventListener('click', toggle);
  update();
  return () => {
    button.removeEventListener('click', toggle);
    host.remove();
    removeFlowMarkers([...processRows, ...outputReasoning]);
  };
}

function installCompletedTurnLayout(
  tail: HTMLElement,
  turnId: number,
  collapseProcess: boolean,
  promotions: Map<string, ArtifactPromotion>,
  desiredPromotions: Set<string>,
): () => void {
  const rows = flowRowsBefore(tail);
  const nodes = rows.map((row) => ({
    kind: row.dataset.chatFlowKind ?? '',
    hasOutput: flowNodeHasOutput(row),
    hasArtifact: flowNodeHasArtifact(row),
  }));
  const disposers = planCompletedProcessSegments(nodes).map((segment, segmentId) => {
    const outputRow = rows[segment.outputIndex];
    if (outputRow === undefined) return () => {};
    const processRows = segment.collapseIndices.flatMap((index) => rows[index] === undefined ? [] : [rows[index]!]);
    const artifactRows = segment.artifactIndices.flatMap((index) => rows[index] === undefined ? [] : [rows[index]!]);
    reconcileArtifactPromotion(promotions, desiredPromotions, turnId, segmentId, outputRow, artifactRows);
    const disposeDisclosure = collapseProcess
      ? installSegmentDisclosure(
        turnId,
        segmentId,
        outputRow,
        processRows,
        segment.toolCount,
        segment.contextCount,
      )
      : () => {};
    return disposeDisclosure;
  });
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

function mutationAddsCompletedTurnOrArtifact(mutation: MutationRecord): boolean {
  const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
  if (target?.closest('[data-dsh-appearance-artifacts], [data-dsh-appearance-segment]') != null) return false;
  const selector = '[data-chat-flow-kind="turn-tail"], [data-turn-tail], '
    + ARTIFACT_OUTPUT + ', ' + ARTIFACT_CONTENT;
  return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => node instanceof Element
    && (node.matches(selector) || node.querySelector(selector) !== null));
}

function installCompletedTurnLayouts(
  scope: SettingsScope<Partial<AppearanceSettings>>,
  officialChatScope: SettingsScope<OfficialChatSettings>,
): () => void {
  let frame: number | undefined;
  let disclosureDisposers: Array<() => void> = [];
  const promotions = new Map<string, ArtifactPromotion>();
  const observer = new MutationObserver((mutations) => {
    if (!mutations.some(mutationAddsCompletedTurnOrArtifact)) return;
    if (frame !== undefined) return;
    frame = window.requestAnimationFrame(refresh);
  });
  const refresh = (): void => {
    frame = undefined;
    observer.disconnect();
    for (const dispose of disclosureDisposers.reverse()) dispose();
    disclosureDisposers = [];
    const desiredPromotions = new Set<string>();
    const officialSnapshot = officialChatScope.getSnapshot();
    const officialTranscriptView = officialSnapshot.status === 'ready'
      ? officialSnapshot.value?.transcriptView
      : undefined;
    const collapseProcess = officialSnapshot.status !== 'loading'
      && customProcessFoldingEnabled(
        readSettings(scope).collapseCompletedProcess,
        officialTranscriptView,
      );
    for (const marker of document.querySelectorAll<HTMLElement>('[data-turn-tail]')) {
      const tail = marker.closest<HTMLElement>('[data-chat-flow-kind="turn-tail"]');
      const turnId = Number(marker.dataset.turnTail);
      if (tail === null || !Number.isSafeInteger(turnId)) continue;
      disclosureDisposers.push(installCompletedTurnLayout(
        tail,
        turnId,
        collapseProcess,
        promotions,
        desiredPromotions,
      ));
    }
    for (const [marker, promotion] of promotions) {
      if (desiredPromotions.has(marker)) continue;
      promotion.dispose();
      promotions.delete(marker);
    }
    observer.observe(document.body, { childList: true, subtree: true });
  };
  refresh();
  const scheduleRefresh = (): void => {
    if (frame === undefined) frame = window.requestAnimationFrame(refresh);
  };
  const unsubscribers = [scope.subscribe(scheduleRefresh), officialChatScope.subscribe(scheduleRefresh)];

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    observer.disconnect();
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    for (const dispose of disclosureDisposers.reverse()) dispose();
    for (const promotion of promotions.values()) promotion.dispose();
    promotions.clear();
  };
}

interface DebouncedSettingSave {
  schedule(value: number): void;
  flush(): void;
  cancel(): void;
}

function useDebouncedSettingSave(
  scope: SettingsScope<Partial<AppearanceSettings>>,
  field: 'chatFontSize' | 'chatLineHeightRatio' | 'processLineHeightRatio',
  setError: React.Dispatch<React.SetStateAction<string | null>>,
): DebouncedSettingSave {
  const timerRef = React.useRef<number | undefined>(undefined);
  const pendingValueRef = React.useRef<number | undefined>(undefined);

  const cancel = React.useCallback((): void => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    pendingValueRef.current = undefined;
  }, []);

  const commit = React.useCallback((): void => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    const value = pendingValueRef.current;
    pendingValueRef.current = undefined;
    if (value === undefined) return;
    void scope.set(field, value).catch((cause: unknown) => setError(String(cause)));
  }, [field, scope, setError]);

  const schedule = React.useCallback((value: number): void => {
    setError(null);
    pendingValueRef.current = value;
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(commit, TYPOGRAPHY_SAVE_DEBOUNCE_MS);
  }, [commit, setError]);

  React.useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    const value = pendingValueRef.current;
    timerRef.current = undefined;
    pendingValueRef.current = undefined;
    if (value !== undefined) void scope.set(field, value).catch(() => {});
  }, [field, scope]);

  return { schedule, flush: commit, cancel };
}

function AppearancePage({ scope }: { scope: SettingsScope<Partial<AppearanceSettings>> }): React.ReactElement {
  const snapshot = React.useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  );
  const settings = normalizeAppearanceSettings(snapshot.value);
  const [fontSize, setFontSize] = React.useState(settings.chatFontSize);
  const [lineHeightRatio, setLineHeightRatio] = React.useState(settings.chatLineHeightRatio);
  const [processLineHeightRatio, setProcessLineHeightRatio] = React.useState(settings.processLineHeightRatio);
  const [error, setError] = React.useState<string | null>(null);
  const writable = snapshot.status === 'ready' && snapshot.writable;
  const fontSizeSave = useDebouncedSettingSave(scope, 'chatFontSize', setError);
  const lineHeightSave = useDebouncedSettingSave(scope, 'chatLineHeightRatio', setError);
  const processLineHeightSave = useDebouncedSettingSave(scope, 'processLineHeightRatio', setError);

  React.useEffect(() => {
    setFontSize(settings.chatFontSize);
    setLineHeightRatio(settings.chatLineHeightRatio);
    setProcessLineHeightRatio(settings.processLineHeightRatio);
  }, [settings.chatFontSize, settings.chatLineHeightRatio, settings.processLineHeightRatio]);

  const save = (field: keyof AppearanceSettings, value: boolean | number): void => {
    setError(null);
    void scope.set(field, value).catch((cause: unknown) => setError(String(cause)));
  };

  return (
    <div className="dsh-appearance-root">
      <h3 className="dsh-appearance-heading">外观</h3>
      <p className="dsh-appearance-intro">只改变聊天的显示方式，不删除轨迹、工具结果或上下文数据。</p>

      <section className="dsh-appearance-section">
        <h4 className="dsh-appearance-section-title">对话</h4>
        <div className="dsh-appearance-card">
          <div className="dsh-appearance-row">
            <div className="dsh-appearance-copy">
              <div className="dsh-appearance-title">每段回复前收起过程</div>
              <div className="dsh-appearance-description">保留每次可见文本；分别收起它前面的上下文、思考、Skill、工具调用和图片分析，可随时展开。</div>
            </div>
            <label className="dsh-appearance-switch">
              <input
                type="checkbox"
                checked={settings.collapseCompletedProcess}
                disabled={!writable}
                aria-label="每段回复前收起过程"
                onChange={(event) => save('collapseCompletedProcess', event.currentTarget.checked)}
              />
              <span />
            </label>
          </div>

          <div className="dsh-appearance-row">
            <div className="dsh-appearance-copy">
              <div className="dsh-appearance-title">对话字号</div>
              <div className="dsh-appearance-description">调整助手回复和过程行；过程文字通常比正文小 2px，最小保持 13px。</div>
            </div>
            <div className="dsh-appearance-size-control">
              <input
                className="dsh-appearance-range"
                type="range"
                min={MIN_CHAT_FONT_SIZE}
                max={MAX_CHAT_FONT_SIZE}
                step={1}
                value={fontSize}
                disabled={!writable}
                aria-label="对话字号"
                onChange={(event) => {
                  const value = Number(event.currentTarget.value);
                  setFontSize(value);
                  applyTypography(value, lineHeightRatio, processLineHeightRatio);
                  fontSizeSave.schedule(value);
                }}
                onPointerUp={fontSizeSave.flush}
                onKeyUp={fontSizeSave.flush}
                onBlur={fontSizeSave.flush}
              />
              <output className="dsh-appearance-size-value">{fontSize}px</output>
            </div>
          </div>

          <div className="dsh-appearance-row">
            <div className="dsh-appearance-copy">
              <div className="dsh-appearance-title">回复行距</div>
              <div className="dsh-appearance-description">按字号比例调整用户消息和助手回复的行距。</div>
            </div>
            <div className="dsh-appearance-size-control">
              <input
                className="dsh-appearance-range"
                type="range"
                min={MIN_CHAT_LINE_HEIGHT_RATIO}
                max={MAX_CHAT_LINE_HEIGHT_RATIO}
                step={0.05}
                value={lineHeightRatio}
                disabled={!writable}
                aria-label="回复行距"
                onChange={(event) => {
                  const value = Number(event.currentTarget.value);
                  setLineHeightRatio(value);
                  applyTypography(fontSize, value, processLineHeightRatio);
                  lineHeightSave.schedule(value);
                }}
                onPointerUp={lineHeightSave.flush}
                onKeyUp={lineHeightSave.flush}
                onBlur={lineHeightSave.flush}
              />
              <output className="dsh-appearance-size-value">{lineHeightRatio.toFixed(2)}×</output>
            </div>
          </div>

          <div className="dsh-appearance-row">
            <div className="dsh-appearance-copy">
              <div className="dsh-appearance-title">过程行距</div>
              <div className="dsh-appearance-description">单独调整上下文、Think、Skill、工具块和折叠按钮的紧凑程度。</div>
            </div>
            <div className="dsh-appearance-size-control">
              <input
                className="dsh-appearance-range"
                type="range"
                min={MIN_PROCESS_LINE_HEIGHT_RATIO}
                max={MAX_PROCESS_LINE_HEIGHT_RATIO}
                step={0.05}
                value={processLineHeightRatio}
                disabled={!writable}
                aria-label="过程行距"
                onChange={(event) => {
                  const value = Number(event.currentTarget.value);
                  setProcessLineHeightRatio(value);
                  applyTypography(fontSize, lineHeightRatio, value);
                  processLineHeightSave.schedule(value);
                }}
                onPointerUp={processLineHeightSave.flush}
                onKeyUp={processLineHeightSave.flush}
                onBlur={processLineHeightSave.flush}
              />
              <output className="dsh-appearance-size-value">{processLineHeightRatio.toFixed(2)}×</output>
            </div>
          </div>

          <div className="dsh-appearance-preview" style={{ fontSize: `${String(fontSize)}px`, lineHeight: lineHeightRatio }}>
            <div className="dsh-appearance-preview-label">预览</div>
            这是对话正文的显示大小。思考与工具过程会保持更轻、更紧凑的层级。
          </div>
        </div>
      </section>

      {fontSize === DEFAULT_CHAT_FONT_SIZE
        && lineHeightRatio === DEFAULT_CHAT_LINE_HEIGHT_RATIO
        && processLineHeightRatio === DEFAULT_PROCESS_LINE_HEIGHT_RATIO ? null : (
        <button
          type="button"
          className="dsh-appearance-process-toggle dsh-appearance-reset"
          disabled={!writable}
          onClick={() => {
            fontSizeSave.cancel();
            lineHeightSave.cancel();
            processLineHeightSave.cancel();
            setFontSize(DEFAULT_CHAT_FONT_SIZE);
            setLineHeightRatio(DEFAULT_CHAT_LINE_HEIGHT_RATIO);
            setProcessLineHeightRatio(DEFAULT_PROCESS_LINE_HEIGHT_RATIO);
            applyTypography(
              DEFAULT_CHAT_FONT_SIZE,
              DEFAULT_CHAT_LINE_HEIGHT_RATIO,
              DEFAULT_PROCESS_LINE_HEIGHT_RATIO,
            );
            save('chatFontSize', DEFAULT_CHAT_FONT_SIZE);
            save('chatLineHeightRatio', DEFAULT_CHAT_LINE_HEIGHT_RATIO);
            save('processLineHeightRatio', DEFAULT_PROCESS_LINE_HEIGHT_RATIO);
          }}
        >
          恢复默认排版
        </button>
      )}
      {error === null ? null : <p className="dsh-appearance-error">保存失败：{error}</p>}
      {snapshot.status === 'unavailable' ? <p className="dsh-appearance-error">当前部署未开放外观设置命名空间。</p> : null}
    </div>
  );
}

export function apply(ctx: ClientCtx): void {
  const scope = ctx.settingsScope.bind<Partial<AppearanceSettings>>({ namespace: SETTINGS_NAMESPACE });
  const officialChatScope = ctx.settingsScope.bind<OfficialChatSettings>({
    namespace: OFFICIAL_CHAT_SETTINGS_NAMESPACE,
  });
  ctx.effect(installStyles, 'dsh-appearance: client styles');
  ctx.effect(() => installPreferences(scope), 'dsh-appearance: apply preferences');
  ctx.effect(
    () => installOfficialTranscriptCompatibility(scope, officialChatScope),
    'dsh-appearance: disable built-in compact transcript',
  );
  ctx.effect(
    () => installCompletedTurnLayouts(scope, officialChatScope),
    'dsh-appearance: completed turn layouts',
  );
  ctx.inject(['desktopContextMenu'], (menuCtx) => {
    menuCtx.effect(() => installFileLinkContextMenu(menuCtx), 'dsh-appearance: file link context menu');
  });

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'appearance',
    order: 34,
    label: '外观',
  }, () => <AppearancePage scope={scope} />));

}
