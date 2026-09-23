/** Client settings and Tool presentation for dedicated image generation. */
import React from 'react';
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client';
import {
  IconChevronDownOutlineRegular,
  IconInspectOutlineRegular,
  IconSparkleRegular,
  Menu,
  StateDot,
  Switch,
  Button,
  SettingsForm,
  SettingsValueField,
  SettingsSecretField,
  type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives';

interface ImageSettings {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  quality?: string;
  size?: string;
}

interface SlotEntryOptions {
  name: string;
  key?: string;
  id?: string;
}

interface ClientCtx {
  effect(setup: () => (() => void), label: string): unknown;
  slots: {
    inject(name: string, register: () => unknown): unknown;
    register(options: SlotEntryOptions, component: unknown): unknown;
  };
  configForms: {
    get<T>(entryId: string): ConfigForm<T>;
  };
}

interface Draft {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  quality: string;
  size: string;
}

type Activation =
  | { status: 'disabled' | 'unconfigured' | 'checking' }
  | { status: 'active'; model: string; credentialSource: string }
  | { status: 'error'; message: string; toolAvailable: boolean };

interface StatusResponse {
  activation: Activation;
  credential: { configured: boolean; source?: string; writable: boolean };
  error?: string;
}

interface ImageBlock {
  type: 'image';
  attachment: ImageAttachmentRef;
}

interface SessionImageRef {
  kind: 'dsh-session-image';
  version: 1;
  sessionId: string;
  imageId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

interface SessionImageBlock {
  type: 'plugin:dfy-session-image';
  version: 1;
  ref: string;
  image: SessionImageRef;
}

interface DisplayImage {
  key: string;
  ref: string;
  name?: string;
}

type ImageLoader = (ref: string) => Promise<string>;

interface ImageLabels {
  image: string;
  open: string;
  loading: string;
  loadFailed: string;
  lightbox: { dialog: string; close: string };
}

interface SelectOption {
  value: string;
  label: string;
}

export const name = 'image-generation';
export const inject = ['slots', 'configForms'];

const STATUS_API = '/api/dsh-image-generation/status';
const RESOURCE_API = '/api/dsh-image-generation/resource';
const STYLE_ID = '@dfy-plugins/dsh-image-generation';

const QUALITY_OPTIONS: readonly SelectOption[] = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低 · 快速草稿' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

const SIZE_OPTIONS: readonly SelectOption[] = [
  { value: 'auto', label: '自动' },
  { value: '1024x1024', label: '1024 × 1024 · 方形' },
  { value: '1536x1024', label: '1536 × 1024 · 横向' },
  { value: '1024x1536', label: '1024 × 1536 · 纵向' },
  { value: '2048x2048', label: '2048 × 2048 · 2K 方形' },
  { value: '2048x1152', label: '2048 × 1152 · 2K 横向' },
  { value: '3840x2160', label: '3840 × 2160 · 4K 横向' },
  { value: '2160x3840', label: '2160 × 3840 · 4K 纵向' },
];

const STYLES = `
.dsh-imagegen-note { margin:12px 0; color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9)); font-size:12px; line-height:1.5; }
.dsh-imagegen-note[data-error] { color:var(--dsw-alias-state-error-primary,#e5484d); }
.dsh-imagegen-field { display:flex; flex-direction:column; gap:6px; padding:12px 0; }
.dsh-imagegen-field + .dsh-imagegen-field { border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22)); }
.dsh-imagegen-field-head { display:flex; align-items:center; gap:8px; }
.dsh-imagegen-label { min-width:0; flex:1; color:var(--dsw-alias-label-primary,inherit); font-size:13px; font-weight:500; line-height:1.5; }
.dsh-imagegen-hint { margin:0; color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9)); font-size:12px; line-height:1.5; }
.dsh-imagegen-select-menu { display:flex; width:100%; }
.dsh-imagegen-select-trigger { box-sizing:border-box; width:100%; color:var(--dsw-alias-label-primary); font:inherit; display:flex; height:36px; appearance:none; align-items:center; justify-content:space-between; gap:12px; padding:0 14px; border:0; border-radius:18px; outline:none; background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.08)); text-align:left; cursor:pointer; font-size:14px; line-height:22px; }
.dsh-imagegen-select-trigger:hover:not(:disabled),.dsh-imagegen-select-trigger[aria-expanded='true'] { background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1)); }
.dsh-imagegen-select-trigger:focus-visible { box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#298df8)); }
.dsh-imagegen-select-trigger:disabled { color:var(--dsw-alias-label-tertiary); cursor:default; }
.dsh-imagegen-select-trigger span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-imagegen-select-trigger svg { flex:none; }
.dsh-imagegen-tool { display:flex; min-width:0; flex-direction:column; }
.dsh-imagegen-tool-row { position:relative; display:flex; min-width:0; height:24px; align-items:center; overflow:hidden; }
.dsh-imagegen-tool-row[data-expandable] { cursor:pointer; }
.dsh-imagegen-tool[data-state='running'] .dsh-imagegen-tool-row::after { position:absolute; inset:0 auto 0 0; width:300px; animation:dsh-imagegen-sweep 2.6s ease-out infinite; background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent) 55%,transparent 100%); content:''; pointer-events:none; }
.dsh-imagegen-tool-leading { display:inline-flex; width:16px; height:16px; flex:none; align-items:center; justify-content:center; margin-right:6px; color:var(--dsw-alias-label-tertiary); }
.dsh-imagegen-tool-title { flex:none; color:var(--dsw-alias-label-secondary); font-size:14px; line-height:24px; }
.dsh-imagegen-tool-separator { width:2px; height:2px; flex:none; margin:0 8px; border-radius:1px; background:var(--dsw-alias-label-caption); }
.dsh-imagegen-tool-summary { min-width:0; flex:auto; overflow:hidden; color:var(--dsw-alias-label-tertiary); font-size:14px; line-height:24px; text-overflow:ellipsis; white-space:nowrap; }
.dsh-imagegen-tool-summary[data-error] { color:var(--dsw-alias-state-error-primary); }
.dsh-imagegen-tool-gallery { width:min(560px,100%); margin:8px 0 4px 22px; }
.dsh-imagegen-gallery { display:flex; max-width:100%; flex-wrap:wrap; gap:8px; }
.dsh-imagegen-thumb { display:grid; width:96px; height:96px; appearance:none; place-items:center; padding:0; overflow:hidden; border:1px solid var(--dsw-alias-border-l2-darkmode-thin,rgba(127,127,127,.2)); border-radius:16px; background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1)); color:var(--dsw-alias-label-secondary,inherit); cursor:zoom-in; }
.dsh-imagegen-gallery[data-single=true] .dsh-imagegen-thumb { width:min(420px,70vw); height:min(420px,70vw); }
.dsh-imagegen-thumb img { display:block; width:100%; height:100%; object-fit:cover; }
.dsh-imagegen-thumb:focus-visible { outline:2px solid var(--dsw-alias-brand-primary,#298df8); outline-offset:2px; }
.dsh-imagegen-retry { cursor:pointer; font:inherit; }
.dsh-imagegen-lightbox { position:fixed; z-index:10000; inset:0; display:grid; place-items:center; padding:32px; background:rgba(0,0,0,.78); cursor:zoom-out; }
.dsh-imagegen-lightbox img { max-width:calc(100vw - 64px); max-height:calc(100vh - 64px); object-fit:contain; cursor:default; }
.dsh-imagegen-lightbox-close { position:fixed; top:20px; right:20px; width:36px; height:36px; border:0; border-radius:999px; background:rgba(255,255,255,.16); color:#fff; cursor:pointer; font-size:24px; line-height:1; }
.dsh-imagegen-tool-output { max-height:220px; margin:6px 0 4px 22px; overflow:auto; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-markdown-code-block); color:var(--dsw-alias-label-secondary); white-space:pre-wrap; overflow-wrap:anywhere; padding:10px 12px; font:var(--dsw-font-markdown-code-block-small); }
.dsh-imagegen-tool-output[data-error] { color:var(--dsw-alias-state-error-primary); }
.dsh-imagegen-tool-inspect { display:inline-flex; align-self:flex-start; align-items:center; gap:4px; margin:4px 0 2px 22px; padding:2px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:999px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:11px; line-height:16px; }
.dsh-imagegen-tool-inspect:hover { background:var(--dsw-alias-interactive-bg-hover-solid); color:var(--dsw-alias-label-primary); }
@keyframes dsh-imagegen-sweep { 0% { left:-300px; } 90%,100% { left:100%; } }
@media (prefers-reduced-motion:reduce) { .dsh-imagegen-tool[data-state='running'] .dsh-imagegen-tool-row::after { display:none; animation:none; } }
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

const resourceUrls = new Map<string, Promise<string>>();

function encodeImageRef(ref: ImageAttachmentRef): string {
  const value = JSON.stringify({
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
  });
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function loadReferencedImage(ref: string): Promise<string> {
  const cached = resourceUrls.get(ref);
  if (cached !== undefined) return cached;
  const pending = fetch(`${RESOURCE_API}?ref=${encodeURIComponent(ref)}`, { cache: 'force-cache' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      return URL.createObjectURL(await response.blob());
    });
  resourceUrls.set(ref, pending);
  void pending.catch(() => resourceUrls.delete(ref));
  return pending;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasImageDimensions(value: Record<string, unknown>): boolean {
  return ['bytes', 'width', 'height'].every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) > 0)
    && typeof value.mediaType === 'string'
    && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(value.mediaType)
    && (value.name === undefined || typeof value.name === 'string');
}

function isAttachment(value: unknown): value is ImageAttachmentRef {
  return isRecord(value) && typeof value.attachmentId === 'string' && value.attachmentId.length > 0
    && hasImageDimensions(value);
}

function isSessionImage(value: unknown): value is SessionImageRef {
  return isRecord(value) && value.kind === 'dsh-session-image' && value.version === 1
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && typeof value.imageId === 'string' && value.imageId.length > 0 && hasImageDimensions(value);
}

function isImageBlock(value: unknown): value is ImageBlock {
  return isRecord(value) && value.type === 'image' && isAttachment(value.attachment);
}

function isSessionImageBlock(value: unknown): value is SessionImageBlock {
  return isRecord(value) && value.type === 'plugin:dfy-session-image' && value.version === 1
    && typeof value.ref === 'string' && value.ref.length > 0 && isSessionImage(value.image);
}

function ImageThumbnail({ image, load, labels, onOpen }: {
  image: DisplayImage;
  load: ImageLoader;
  labels: ImageLabels;
  onOpen(url: string, alt: string): void;
}): React.ReactElement {
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<{ url?: string; failed?: boolean }>({});
  const alt = image.name ?? labels.image;
  React.useEffect(() => {
    let active = true;
    setState({});
    void load(image.ref).then(
      (url) => { if (active) setState({ url }); },
      () => { if (active) setState({ failed: true }); },
    );
    return () => { active = false; };
  }, [image.ref, attempt, load]);
  if (state.failed === true) {
    return <button type="button" className="dsh-imagegen-thumb dsh-imagegen-retry" onClick={() => setAttempt((value) => value + 1)}>{labels.loadFailed}</button>;
  }
  return (
    <button
      type="button"
      className="dsh-imagegen-thumb"
      aria-label={alt}
      title={labels.open}
      disabled={state.url === undefined}
      onClick={() => { if (state.url !== undefined) onOpen(state.url, alt); }}
    >
      {state.url === undefined ? labels.loading : <img src={state.url} alt={alt} />}
    </button>
  );
}

function ImageGallery({ images, load, labels }: {
  images: readonly DisplayImage[];
  load: ImageLoader;
  labels: ImageLabels;
}): React.ReactElement | null {
  const [open, setOpen] = React.useState<{ url: string; alt: string }>();
  React.useEffect(() => {
    if (open === undefined) return undefined;
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(undefined); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);
  if (images.length === 0) return null;
  return (
    <>
      <div className="dsh-imagegen-gallery" data-single={images.length === 1 ? 'true' : 'false'}>
        {images.map((image) => (
          <ImageThumbnail
            key={image.key}
            image={image}
            load={load}
            labels={labels}
            onOpen={(url, alt) => setOpen({ url, alt })}
          />
        ))}
      </div>
      {open !== undefined && (
        <div className="dsh-imagegen-lightbox" role="dialog" aria-modal="true" aria-label={labels.lightbox.dialog} onClick={() => setOpen(undefined)}>
          <button type="button" className="dsh-imagegen-lightbox-close" aria-label={labels.lightbox.close} onClick={() => setOpen(undefined)}>×</button>
          <img src={open.url} alt={open.alt} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </>
  );
}

function firstLine(value: string): string {
  return value.split('\n', 1)[0] ?? value;
}

function toolOutput(block: ToolCallViewProps['block']): string | null {
  if (!('kind' in block)) return null;
  const parts = block.content.flatMap((item: unknown) => {
    if (isImageBlock(item) || isSessionImageBlock(item)) return [];
    if (typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text') {
      const text = (item as { text?: unknown }).text;
      return typeof text === 'string' ? [text] : [];
    }
    return [JSON.stringify(item, null, 2)];
  });
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`);
  return parts.join('\n') || null;
}

function toolPrompt(block: ToolCallViewProps['block']): string {
  const raw = ('kind' in block ? block.call?.argsRaw : 'argsRaw' in block ? block.argsRaw : undefined) ?? '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.prompt === 'string' && parsed.prompt.trim().length > 0) return firstLine(parsed.prompt.trim());
  } catch {}
  return '生成图片';
}

function resultImages(block: ToolCallViewProps['block']): DisplayImage[] {
  if (!('kind' in block) || block.isError) return [];
  const images: DisplayImage[] = [];
  const add = (ref: string, name?: string): void => {
    if (!images.some((image) => image.ref === ref)) images.push({ key: ref, ref, name });
  };

  // 0.1.5 sends durable metadata directly; it no longer projects resultView.
  const meta = isRecord(block.meta) ? block.meta : undefined;
  for (const item of Array.isArray(meta?.images) ? meta.images : []) {
    if (!isRecord(item) || typeof item.ref !== 'string' || item.ref.length === 0) continue;
    if (isSessionImage(item.image)) add(item.ref, item.image.name);
    else if (isAttachment(item.attachment)) add(item.ref, item.attachment.name);
  }
  if (images.length > 0) return images;

  // Historical plugin blocks are external data, validated by our own guards.
  const content: readonly unknown[] = block.content;
  for (const item of content) {
    if (isSessionImageBlock(item)) {
      add(item.ref, item.image.name);
    } else if (isImageBlock(item)) {
      add(encodeImageRef(item.attachment), item.attachment.name);
    }
  }
  if (images.length > 0) return images;

  // PTC child calls omit presentationMeta but retain our own output envelope.
  // References stay opaque and still pass through the validated resource route.
  for (const part of block.content) {
    if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') continue;
    const envelope = /^<image_generation_result\b[^>]*>([\s\S]*?)<\/image_generation_result>$/.exec(part.text.trim());
    if (envelope === null) continue;
    for (const match of envelope[1]!.matchAll(/<generated_image\b([^>]*)\/>/g)) {
      const ref = /\bimage_ref="([A-Za-z0-9_-]{1,2048})"/.exec(match[1]!)?.[1];
      if (ref === undefined) continue;
      const name = /\bname="([^"]*)"/.exec(match[1]!)?.[1]
        ?.replace(/&(quot|lt|gt|amp);/g, (entity) => ({ '&quot;': '"', '&lt;': '<', '&gt;': '>', '&amp;': '&' })[entity]!);
      add(ref, name);
    }
  }
  return images;
}

function ImageToolRow({ block, inspect }: ToolCallViewProps): React.ReactElement {
  const settled = 'kind' in block;
  const preparing = !settled && 'phase' in block && block.phase === 'preparing';
  const output = toolOutput(block);
  const images = resultImages(block);
  const state = !settled ? 'running' : block.error?.code === 'interrupted' ? 'stopped' : block.isError ? 'error' : 'ok';
  const summary = preparing ? '正在准备图像生成' : state === 'error' && output !== null ? firstLine(output) : toolPrompt(block);
  const [open, setOpen] = React.useState(false);
  const expandable = output !== null;
  const loader = React.useCallback<ImageLoader>((ref) => loadReferencedImage(ref), []);
  const labels = {
    image: '生成的图片',
    open: '打开原图',
    loading: '正在加载图片',
    loadFailed: '图片加载失败',
    lightbox: { dialog: '图片预览', close: '关闭预览' },
  };
  const toggle = (): void => { if (expandable) setOpen((value) => !value); };

  return (
    <div
      className="dsh-imagegen-tool"
      data-state={state}
      data-tool="dfy_image_generate"
      data-dsh-image-output={images.length === 0 ? undefined : ''}
    >
      <div
        className="dsh-imagegen-tool-row"
        data-expandable={expandable || undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={toggle}
        onKeyDown={(event) => {
          if (!expandable || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          toggle();
        }}
      >
        <span className="dsh-imagegen-tool-leading">
          {state === 'error' ? <StateDot state="error" /> : state === 'stopped' ? <StateDot state="warning" /> : open ? <IconChevronDownOutlineRegular /> : <IconSparkleRegular size={14} />}
        </span>
        <span className="dsh-imagegen-tool-title">DFY IMAGE GENERATE</span>
        <span className="dsh-imagegen-tool-separator" aria-hidden />
        <span className="dsh-imagegen-tool-summary" data-error={state === 'error' || undefined}>{summary}</span>
      </div>
      {images.length === 0 ? null : (
        <div className="dsh-imagegen-tool-gallery" data-dsh-artifact-content="image">
          <ImageGallery images={images} load={loader} labels={labels} />
        </div>
      )}
      {open && output !== null ? (
        <>
          <pre className="dsh-imagegen-tool-output" data-error={state === 'error' || undefined}>{output}</pre>
          {inspect === undefined ? null : (
            <button type="button" className="dsh-imagegen-tool-inspect" onClick={inspect}>
              <IconInspectOutlineRegular /> Inspect
            </button>
          )}
        </>
      ) : null}
    </div>
  );
}

function draftOf(value: ImageSettings | undefined): Draft {
  return {
    enabled: value?.enabled ?? false,
    baseUrl: value?.baseUrl ?? '',
    apiKey: '',
    model: value?.model ?? '',
    quality: value?.quality ?? 'auto',
    size: value?.size ?? 'auto',
  };
}

function activationLabel(activation: Activation | null): string {
  if (activation === null) return '检查中';
  switch (activation.status) {
    case 'active': return '已启用';
    case 'checking': return '正在检查';
    case 'disabled': return '已关闭';
    case 'unconfigured': return '尚未配置';
    case 'error': return activation.toolAvailable ? '凭据待配置' : '配置异常';
  }
}

function ImageSelect({
  ariaLabel,
  value,
  options,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: readonly SelectOption[];
  disabled: boolean;
  onChange(value: string): void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;
  const items = React.useMemo<readonly MenuItem[]>(
    () => options.map((option) => ({ id: option.value, label: option.label })),
    [options],
  );
  React.useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return (
    <Menu
      align="end"
      className="dsh-imagegen-select-menu"
      open={open && !disabled}
      portal
      items={items}
      selectedId={value}
      onClose={() => setOpen(false)}
      onSelect={(id) => { onChange(String(id)); setOpen(false); }}
      anchor={(
        <button
          type="button"
          className="dsh-imagegen-select-trigger"
          aria-label={`${ariaLabel}，当前：${selectedLabel}`}
          aria-haspopup="menu"
          aria-expanded={open && !disabled}
          disabled={disabled}
          onClick={() => setOpen((current) => !current)}
        >
          <span>{selectedLabel}</span>
          <IconChevronDownOutlineRegular size={16} />
        </button>
      )}
    />
  );
}

function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function ImageSettingsPage({ scope }: { scope: ConfigForm<ImageSettings> }): React.ReactElement {
  const snapshot = React.useSyncExternalStore(
    (listener) => scope.subscribe(listener),
    () => scope.getSnapshot(),
    () => scope.getSnapshot(),
  );
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(snapshot.value));
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [status, setStatus] = React.useState<StatusResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const loadStatus = React.useCallback(() => {
    setLoadError(null);
    return fetch(STATUS_API, { cache: 'no-store' })
      .then(async (response) => {
        const body = await response.json() as StatusResponse;
        if (!response.ok) throw new Error(body.error ?? `HTTP ${String(response.status)}`);
        setStatus(body);
      })
      .catch((error: unknown) => setLoadError(String(error)));
  }, []);

  React.useEffect(() => { void loadStatus(); }, [loadStatus]);
  React.useEffect(() => {
    if (dirty || saving) return;
    setDraft(draftOf(snapshot.value));
  }, [dirty, saving, snapshot.revision, snapshot.value]);

  const edit = <K extends keyof Draft>(field: K, value: Draft[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }));
    setDirty(true);
    setSaveError(null);
  };

  const credentialConfigured = status?.credential.configured === true;
  const credentialWritable = status?.credential.writable === true;
  const complete = draft.baseUrl.trim().length > 0
    && draft.model.trim().length > 0
    && (credentialConfigured || draft.apiKey.trim().length > 0);
  const baseUrlPresent = draft.baseUrl.trim().length > 0;
  const baseUrlValid = !baseUrlPresent || validBaseUrl(draft.baseUrl);
  const writable = snapshot.status === 'ready' && snapshot.writable;
  const canSave = writable && dirty && !saving && (!draft.enabled || complete) && baseUrlValid
    && (draft.apiKey.trim().length === 0 || credentialWritable);

  const save = (): void => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    void (async () => {
      try {
        if (draft.apiKey.trim().length > 0) {
          const response = await fetch(STATUS_API, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ apiKey: draft.apiKey }),
          });
          const body = await response.json() as StatusResponse;
          if (!response.ok) throw new Error(body.error ?? `HTTP ${String(response.status)}`);
          setStatus(body);
        }
        const accepted = await scope.mutate([
          { op: 'set', path: ['enabled'], value: draft.enabled },
          { op: 'set', path: ['baseUrl'], value: draft.baseUrl.trim() },
          { op: 'set', path: ['model'], value: draft.model.trim() },
          { op: 'set', path: ['quality'], value: draft.quality },
          { op: 'set', path: ['size'], value: draft.size },
        ], snapshot.revision);
        if (!accepted) throw new Error('设置未保存，请刷新后重试。');
        setDraft((current) => ({ ...current, apiKey: '' }));
        setDirty(false);
        await loadStatus();
      } catch (error) {
        setSaveError(String(error));
      } finally {
        setSaving(false);
      }
    })();
  };

  return (
    <SettingsForm
      labels={{
        unavailable: snapshot.status === 'loading' ? '正在加载设置…' : '该插件当前未加载，暂时无法配置。',
        readOnly: '本部署的设置为只读。', saveFailed: saveError ?? '设置未保存，请重试。',
        save: '保存', saving: '保存中…',
      }}
      state={{ available: snapshot.status === 'ready', writable, dirty, invalid: !canSave, saving, failed: saveError !== null }}
      onSave={save}
      onDiscard={() => { setDraft(draftOf(scope.getSnapshot().value)); setDirty(false); setSaveError(null); }}
    >
      <p className="dsh-imagegen-note" role="status">当前状态：{activationLabel(status?.activation ?? null)}</p>
      <p className="dsh-imagegen-note">默认兼容 OpenAI Images API。API Key 独立保存在 Harness 凭据层，不会写入普通插件设置。</p>
      {loadError === null ? null : <p className="dsh-imagegen-note" role="alert" data-error>{loadError}</p>}
      {status?.activation.status === 'error' ? <p className="dsh-imagegen-note" data-error>{status.activation.message}</p> : null}
      <SettingsValueField
        id="dsh-imagegen-base-url" label="API Base URL" text={draft.baseUrl}
        hint="例如 https://api.teamorouter.com/v1；插件会调用 images/generations 或 images/edits。"
        disabled={!writable || saving} invalid={!baseUrlValid} invalidLabel="Base URL 必须是有效的 HTTP 或 HTTPS 地址。"
        overridden={false} overriddenLabel="已覆盖" resetLabel="恢复默认"
        onEdit={(value) => edit('baseUrl', value)} onReset={() => edit('baseUrl', '')}
      />
      <SettingsSecretField
        id="dsh-imagegen-credential" label="API 密钥" text={draft.apiKey}
        hint="已保存的密钥不会回显；留空会保留现有值。"
        configured={credentialConfigured} stateLabel={credentialConfigured ? '已配置' : '未配置'}
        disabled={!writable || !credentialWritable || saving} onEdit={(value) => edit('apiKey', value)}
      />
      <SettingsValueField
        id="dsh-imagegen-model" label="图像模型" text={draft.model}
        hint="例如 gpt-image-2；它只属于此工具，不会出现在会话模型选择器。"
        disabled={!writable || saving} invalid={false} invalidLabel="请填写模型名称。"
        overridden={false} overriddenLabel="已覆盖" resetLabel="恢复默认"
        onEdit={(value) => edit('model', value)} onReset={() => edit('model', '')}
      />
      <div className="dsh-imagegen-field">
        <div className="dsh-imagegen-field-head"><div className="dsh-imagegen-label">默认质量</div></div>
        <ImageSelect ariaLabel="默认质量" value={draft.quality} options={QUALITY_OPTIONS} disabled={!writable || saving} onChange={(value) => edit('quality', value)} />
      </div>

      <div className="dsh-imagegen-field">
        <div className="dsh-imagegen-field-head"><div className="dsh-imagegen-label">默认尺寸</div></div>
        <ImageSelect ariaLabel="默认尺寸" value={draft.size} options={SIZE_OPTIONS} disabled={!writable || saving} onChange={(value) => edit('size', value)} />
        <p className="dsh-imagegen-hint">模型仍可在单次工具调用中覆盖质量和尺寸。</p>
      </div>

      <div className="dsh-imagegen-field">
        <div className="dsh-imagegen-field-head">
          <div className="dsh-imagegen-label">启用图像生成工具</div>
          <Switch label="启用图像生成工具" checked={draft.enabled} disabled={!writable || saving || (!draft.enabled && !complete)} onChange={(checked) => edit('enabled', checked)} />
        </div>
        <p className="dsh-imagegen-hint">启用后注册固定的 dfy_image_generate 工具和 dfy-image-generation Skill。</p>
      </div>

      {!complete ? <p className="dsh-imagegen-note" data-error>启用前请补全 Base URL、API 密钥和模型。</p> : null}
      {baseUrlPresent && !baseUrlValid ? <p className="dsh-imagegen-note" data-error>Base URL 必须是有效的 HTTP 或 HTTPS 地址。</p> : null}
      {!credentialWritable ? <p className="dsh-imagegen-note" data-error>当前凭据来源不可由设置页替换。</p> : null}
      <div><Button variant="outline" size="sm" disabled={saving} onClick={() => void loadStatus()}>刷新状态</Button></div>
    </SettingsForm>
  );
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(installStyles, 'dsh-image-generation: client styles');
  ctx.effect(() => () => {
    for (const pending of resourceUrls.values()) void pending.then((url) => URL.revokeObjectURL(url));
    resourceUrls.clear();
  }, 'dsh-image-generation: release object URLs');
  const scope = ctx.configForms.get<ImageSettings>('image-generation');
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'dfy_image_generate',
  }, ImageToolRow));
  // Standalone installs configure on their package page; the combined bundle
  // opens the same form from the component row. The manager owns navigation.
  const SettingsView = ({ view }: PluginConfigViewProps): React.ReactNode => view === 'summary'
    ? '通过独立生图路由生成或编辑图片，不进入主对话模型列表。'
    : <ImageSettingsPage scope={scope} />;
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@dfy-plugins/dsh-image-generation',
  }, SettingsView));
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
    name: 'plugins.row.config',
    key: '@dfy-plugins/dsh-bundle#image-generation',
  }, SettingsView));
}
