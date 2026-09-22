/** @dfy-plugins/dsh-appearance Client half: typography settings and artifact placement. */
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
  normalizeAppearanceSettings,
  planArtifactPlacements,
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
  set(field: string, value: unknown): Promise<boolean>;
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
  configForms: {
    get<T>(entryId: string): SettingsScope<T>;
  };
}

export const name = 'appearance';
export const inject = ['slots', 'configForms'];

const STYLE_ID = '@dfy-plugins/dsh-appearance';
const BODY_ATTRIBUTE = 'data-dsh-appearance';
const SETTINGS_NAMESPACE = 'appearance';
const MEDIA_CONTENT = 'img, video, audio';
const ARTIFACT_OUTPUT = '[data-dsh-visualization-output], [data-dsh-image-output]';
const ARTIFACT_CONTENT = '[data-dsh-artifact-content]';
const TYPOGRAPHY_SAVE_DEBOUNCE_MS = 250;
const OPEN_FILE_PATH = '/api/dsh-desktop/shell/open';
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
      return [{
        url: url.href,
        hasSource: source.length > 0,
        matches: source.length > 0 && (source === identity
          || ((!isAbsoluteHostPath(source) || !isAbsoluteHostPath(identity)) && sourceBasename === basename)),
      }];
    });
    const matches = candidates.filter((candidate) => candidate.matches);
    if (matches.length === 1) return matches[0]!.url;
    if (matches.length === 0 && candidates.length === 1 && !candidates[0]!.hasSource
      && scope.matches('[data-dsh-visualization-output], [data-dsh-artifact-content="visualization"]')) {
      return candidates[0]!.url;
    }
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

function localHtmlFileURL(path: string): string {
  if (!isAbsoluteHostPath(path) || !/\.(?:html?|xhtml)$/iu.test(path) || path.includes('\0')) return '';
  // Network shares are not local browser targets. Keep their existing file actions.
  if (/^(?:\\\\|\/\/)/u.test(path)) return '';
  const windowsDrive = /^[a-z]:[\\/]/iu.test(path) ? path.slice(0, 2) : '';
  const pathname = windowsDrive.length > 0 ? path.slice(2).replaceAll('\\', '/') : path;
  try {
    // Encode each path segment so #, %, spaces and Unicode remain filename characters.
    const encoded = pathname.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    return new URL(windowsDrive.length > 0 ? `file:///${windowsDrive}${encoded}` : `file://${encoded}`).href;
  } catch {
    return '';
  }
}

function localHtmlLinkForFile(ctx: ClientCtx, target: Element): string {
  const path = filePathForButton(fileLinkButton(target));
  // A URI must not become a path below the current session's working directory.
  if (/^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path)) return '';
  return localHtmlFileURL(resolvedFilePath(ctx, target));
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

async function requestDesktopShell(pathname: string, path: string): Promise<Response> {
  return await fetch(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

async function shellFailure(response: Response): Promise<Error> {
  const payload = await response.json().catch(() => ({})) as { message?: unknown };
  return new Error(typeof payload.message === 'string' ? payload.message : `HTTP ${String(response.status)}`);
}

async function revealFile(path: string): Promise<void> {
  const response = await requestDesktopShell(REVEAL_FILE_PATH, path);
  if (response.ok) return;
  throw await shellFailure(response);
}

async function openWorkspaceFolder(ctx: ClientCtx, path: string): Promise<void> {
  const response = await requestDesktopShell(OPEN_FILE_PATH, path);
  if (response.ok) return;
  throw await shellFailure(response);
}

function installFileLinkContextMenu(ctx: ClientCtx): () => void {
  const service = ctx.desktopContextMenu
    ?? ctx.get?.('desktopContextMenu') as DesktopContextMenuService | undefined;
  if (service === undefined || typeof service.register !== 'function') return () => {};
  const disposers = [service.register({
    id: 'appearance.open-file',
    label: '打开文件',
    linkURL: (context) => visualizationLinkForFile(fileLinkButton(context.target))
      || localHtmlLinkForFile(ctx, context.target),
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
      const path = workspacePathForTarget(ctx, context.target);
      if (path.length > 0) await openWorkspaceFolder(ctx, path);
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
.dsh-appearance-reset {
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
.dsh-appearance-reset:hover { color: var(--dsw-alias-label-primary); }
.dsh-appearance-reset:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
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
.dsh-appearance-size-control { display: grid; width: min(260px, 42%); flex: none; grid-template-columns: minmax(120px, 1fr) 42px; align-items: center; gap: 12px; }
.dsh-appearance-range { width: 100%; accent-color: var(--dsw-alias-brand-primary); }
.dsh-appearance-size-value { color: var(--dsw-alias-label-secondary); font-size: 13px; font-variant-numeric: tabular-nums; text-align: right; }
.dsh-appearance-preview { padding: 16px; color: var(--dsw-alias-label-primary); line-height: 1.75; }
.dsh-appearance-preview-label { margin-bottom: 6px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 17px; }
.dsh-appearance-error { margin: 12px 2px 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
@media (max-width: 620px) {
  .dsh-appearance-row { align-items: flex-start; flex-direction: column; gap: 10px; }
  .dsh-appearance-size-control { width: 100%; }
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

function turnFlowGroups(): HTMLElement[][] {
  // 0.1.7 keeps process members under stable group containers. Read logical
  // turn order across those containers instead of treating each as a turn.
  const parents = [...document.querySelectorAll<HTMLElement>('[data-chat-flow]')]
    .filter((flow) => flow.closest('[data-chat-group-key]') === null);
  const groups: HTMLElement[][] = [];
  for (const parent of parents) {
    let rows: HTMLElement[] = [];
    let turn: string | undefined;
    for (const row of parent.querySelectorAll<HTMLElement>('[data-chat-flow-kind]')) {
      if (!(row instanceof HTMLElement)) continue;
      const kind = row.dataset.chatFlowKind;
      if (kind === undefined || kind === 'turn-process') continue;
      const nextTurn = row.dataset.chatTurn;
      if (kind === 'user' || kind === 'turn-tail'
        || (turn !== undefined && nextTurn !== undefined && turn !== nextTurn)) {
        if (rows.length > 0) groups.push(rows);
        rows = [];
        turn = undefined;
      }
      if (kind === 'user' || kind === 'turn-tail') continue;
      rows.push(row);
      if (nextTurn !== undefined) turn = nextTurn;
    }
    if (rows.length > 0) groups.push(rows);
  }
  return groups;
}

function flowNodeHasOutput(row: HTMLElement): boolean {
  if (row.dataset.chatFlowKind === 'assistant-step' && row.dataset.chatGroupPart !== 'reasoning') {
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
  marker: string,
  outputRow: HTMLElement,
  artifactRows: readonly HTMLElement[],
): ArtifactPromotion | undefined {
  const contents = artifactRows.flatMap((row) => [...row.querySelectorAll<HTMLElement>(ARTIFACT_CONTENT)]);
  if (contents.length === 0) return undefined;
  const host = document.createElement('div');
  host.className = 'dsh-appearance-artifacts';
  host.dataset.dshAppearanceArtifacts = marker;
  (outputRow.closest('[data-chat-group-key]') ?? outputRow).after(host);
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
  marker: string,
  outputRow: HTMLElement,
  artifactRows: readonly HTMLElement[],
): void {
  const current = promotions.get(marker);
  if (current !== undefined
    && current.host.isConnected
    && current.outputRow === outputRow
    && sameElements(current.artifactRows, artifactRows)) return;
  current?.dispose();
  const next = installArtifactPromotion(marker, outputRow, artifactRows);
  if (next === undefined) promotions.delete(marker);
  else promotions.set(marker, next);
}

function planTurnArtifactPlacements(rows: HTMLElement[], knownOutputs: WeakSet<HTMLElement>) {
  const nodes = rows.map((row) => ({
    kind: row.dataset.chatFlowKind ?? '',
    hasOutput: flowNodeHasOutput(row),
    hasArtifact: flowNodeHasArtifact(row),
  }));
  nodes.forEach((node, index) => { if (node.hasOutput) knownOutputs.add(rows[index]!); });
  return planArtifactPlacements(nodes).map((segment) => {
    const outputRow = rows[segment.outputIndex]!;
    const artifactRows = segment.artifactIndices.flatMap((index) => rows[index] === undefined ? [] : [rows[index]!]);
    return { ...segment, outputRow, artifactRows };
  });
}

function mutationChangesTurnFlow(mutation: MutationRecord, knownOutputs: WeakSet<HTMLElement>): boolean {
  const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
  if (target?.closest('[data-dsh-appearance-artifacts]') != null) return false;
  if (mutation.type === 'attributes') return true;
  // React can create the Assistant row before its first text delta. Observe
  // that first visible output, but do not move artifacts again for every token.
  const assistant = target?.closest<HTMLElement>('[data-chat-flow-kind="assistant-step"]');
  if (assistant != null && !knownOutputs.has(assistant)
    && target?.closest('[data-variant="think"]') == null && flowNodeHasOutput(assistant)) return true;
  const selector = '[data-chat-flow-kind], [data-turn-tail], [data-variant="think"], '
    + ARTIFACT_OUTPUT + ', ' + ARTIFACT_CONTENT;
  return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => node instanceof Element
    && (node.matches(selector) || node.querySelector(selector) !== null));
}

function installArtifactPlacements(): () => void {
  let frame: number | undefined;
  const promotions = new Map<string, ArtifactPromotion>();
  const outputIds = new WeakMap<HTMLElement, number>();
  let nextOutputId = 0;
  let knownOutputs = new WeakSet<HTMLElement>();
  const observer = new MutationObserver((mutations) => {
    if (!mutations.some((mutation) => mutationChangesTurnFlow(mutation, knownOutputs))) return;
    if (frame !== undefined) return;
    frame = window.requestAnimationFrame(refresh);
  });
  const refresh = (): void => {
    frame = undefined;
    observer.disconnect();
    knownOutputs = new WeakSet<HTMLElement>();
    const segments = turnFlowGroups().flatMap((rows) => planTurnArtifactPlacements(rows, knownOutputs)).map((segment) => {
      let id = outputIds.get(segment.outputRow);
      if (id === undefined) {
        id = nextOutputId++;
        outputIds.set(segment.outputRow, id);
      }
      return { ...segment, marker: `output:${String(id)}` };
    });
    const desiredPromotions = new Set(segments.map(({ marker }) => marker));
    // Restore old placements before promoting again: an artifact may first be
    // the latest output and later belong after a newly streamed text response.
    for (const [marker, promotion] of promotions) {
      if (desiredPromotions.has(marker)) continue;
      promotion.dispose();
      promotions.delete(marker);
    }
    for (const segment of segments) {
      reconcileArtifactPromotion(promotions, segment.marker, segment.outputRow, segment.artifactRows);
    }
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-chat-flow-kind', 'data-chat-turn', 'data-turn-tail', 'data-chat-group-part'],
    });
  };
  refresh();

  return () => {
    observer.disconnect();
    if (frame !== undefined) window.cancelAnimationFrame(frame);
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

  const save = (field: keyof AppearanceSettings, value: number): void => {
    setError(null);
    void scope.set(field, value).catch((cause: unknown) => setError(String(cause)));
  };

  return (
    <div className="dsh-appearance-root">
      <h3 className="dsh-appearance-heading">外观</h3>
      <p className="dsh-appearance-intro">调整对话字号、回复行距和过程行距。</p>

      <section className="dsh-appearance-section">
        <h4 className="dsh-appearance-section-title">对话</h4>
        <div className="dsh-appearance-card">
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
          className="dsh-appearance-reset"
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
  const scope = ctx.configForms.get<Partial<AppearanceSettings>>(SETTINGS_NAMESPACE );
  ctx.effect(installStyles, 'dsh-appearance: client styles');
  ctx.effect(() => installPreferences(scope), 'dsh-appearance: apply preferences');
  ctx.effect(installArtifactPlacements, 'dsh-appearance: artifact placement');
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
