/** Client projection for @dfy-plugins/dsh-media-blocks. */
import React from 'react';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import {
  RpcId,
  type IApiClient,
  type PromptContentPart,
  type RpcResponse,
  type SessionModels,
} from '@deepseek-ai/dsh-client-connection/client';
import {
  IconCheckOutline16,
  IconCopyOutline16,
  IconSparkle16,
  JsonBlock,
  MessageText,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives';

export const name = 'media-blocks';
export const inject = ['slots', 'connection'];

const BLOCK_TYPE = 'dfy-media';
const PROMPT_API = '/api/dsh-media-blocks/prompt';
const RESOURCE_API = '/api/dsh-media-blocks/resource';
const STYLE_ID = '@dfy-plugins/dsh-media-blocks';

interface SlotEntryOptions {
  name: string;
  key?: string;
  id?: string;
  order?: number;
  priority?: number;
  locale?: string;
}

interface ClientCtx {
  effect(callback: () => (() => void) | void, label?: string): unknown;
  slots: {
    inject(name: string, register: () => unknown): unknown;
    register(options: SlotEntryOptions, component: unknown): unknown;
  };
  connection: { api: IApiClient };
}

interface MediaImageBlock {
  type: typeof BLOCK_TYPE;
  version: 1;
  resource: {
    kind: 'image';
    ref: string;
    attachment: ImageAttachmentRef;
  };
  presentation?: { name?: string; caption?: string; renderer?: string };
}

interface InputProps {
  input: { phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting' };
}

interface ChatNodeProps {
  node: {
    seq: number;
    data: { time: number; content: readonly unknown[] };
  };
  loadImage: ImageLoader;
  t(key: string, values?: Record<string, unknown>): string;
}

type ImageLoader = (attachment: ImageAttachmentRef) => Promise<string>;

interface ImageLabels {
  image: string;
  open: string;
  loading: string;
  loadFailed: string;
  lightbox: { dialog: string; close: string };
}

interface PromptEndpointResponse {
  result?: RpcResponse<{ accepted: true }>['result'];
  error?: string;
}

const STYLES = `
.dsh-media-input { display:inline-flex; align-items:center; }
.dsh-media-file { display:none; }
.dsh-media-add { display:inline-flex; width:28px; height:28px; appearance:none; align-items:center; justify-content:center; padding:0; border:0; border-radius:8px; background:transparent; color:var(--dsw-alias-label-secondary, inherit); cursor:pointer; }
.dsh-media-add:hover:not(:disabled) { background:var(--dsw-alias-bg-module-platform, rgba(127,127,127,.1)); color:var(--dsw-alias-label-primary, inherit); }
.dsh-media-add:focus-visible { outline:2px solid var(--dsw-alias-brand-primary, #298df8); outline-offset:1px; }
.dsh-media-add:disabled { cursor:default; opacity:.4; }
@container (width <= 540px) {
  [data-composer-card]
    > div:has(> div > [data-slot="conversation.input.left"] .dsh-media-input)
    > div
    > div:has(> [data-slot="conversation.input.plan"])
    button:has(> span:first-child[aria-hidden=true])
    > span:nth-of-type(2):not([aria-hidden]) { display:none; }
}
.dsh-media-user-row { display:flex; flex-direction:column; align-items:flex-end; gap:6px; }
.dsh-media-user-stack { display:flex; min-width:0; max-width:min(525px,82%); flex-direction:column; align-items:flex-end; gap:8px; }
.dsh-media-user-bubble { max-width:100%; padding:10px 16px; border-radius:22px; background:var(--dsw-specific-bubble); color:var(--dsw-alias-label-primary); font-size:16px; line-height:24px; }
.dsh-media-user-actions { display:flex; align-items:center; justify-content:flex-end; gap:4px; min-height:20px; color:var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.dsh-media-user-action { display:inline-flex; width:24px; height:24px; appearance:none; align-items:center; justify-content:center; padding:0; border:0; border-radius:6px; background:transparent; color:inherit; cursor:pointer; }
.dsh-media-user-action:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); color:var(--dsw-alias-label-secondary, inherit); }
.dsh-media-gallery { display:flex; max-width:100%; flex-wrap:wrap; justify-content:flex-end; gap:8px; }
.dsh-media-thumb { display:grid; width:64px; height:64px; appearance:none; place-items:center; padding:0; overflow:hidden; border:1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(127,127,127,.2)); border-radius:16px; background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.1)); color:var(--dsw-alias-label-secondary, inherit); cursor:zoom-in; }
.dsh-media-gallery[data-single=true] .dsh-media-thumb { width:min(300px,70vw); height:min(300px,70vw); }
.dsh-media-thumb img { display:block; width:100%; height:100%; object-fit:cover; }
.dsh-media-thumb:focus-visible { outline:2px solid var(--dsw-alias-brand-primary, #298df8); outline-offset:2px; }
.dsh-media-retry { cursor:pointer; font:inherit; }
.dsh-media-lightbox { position:fixed; z-index:10000; inset:0; display:grid; place-items:center; padding:32px; border:0; background:rgba(0,0,0,.78); cursor:zoom-out; }
.dsh-media-lightbox img { max-width:calc(100vw - 64px); max-height:calc(100vh - 64px); object-fit:contain; cursor:default; }
.dsh-media-lightbox-close { position:fixed; top:20px; right:20px; width:36px; height:36px; border:0; border-radius:999px; background:rgba(255,255,255,.16); color:#fff; cursor:pointer; font-size:24px; line-height:1; }
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

function isMediaImageBlock(value: unknown): value is MediaImageBlock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const block = value as Partial<MediaImageBlock>;
  return block.type === BLOCK_TYPE
    && block.resource?.kind === 'image'
    && typeof block.resource.ref === 'string'
    && typeof block.resource.attachment === 'object'
    && block.resource.attachment !== null;
}

async function jsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (text.trim().length === 0) throw new Error(`HTTP ${String(response.status)} 返回空响应`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`HTTP ${String(response.status)} 返回无效 JSON`);
  }
}

function MediaImageButton({ input }: InputProps): React.ReactElement {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const locked = input.phase === 'adjudicating' || input.phase === 'submitting';
  const add = (files: readonly File[]): void => {
    if (files.length === 0) return;
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    document.dispatchEvent(new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
    }));
  };
  return (
    <span className="dsh-media-input">
      <input
        ref={fileRef}
        className="dsh-media-file"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        tabIndex={-1}
        onChange={(event) => {
          add(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = '';
        }}
      />
      <Tooltip label="添加图片" side="top" delayMs={500}>
        <button
          type="button"
          className="dsh-media-add"
          aria-label="添加图片"
          disabled={locked}
          onClick={() => fileRef.current?.click()}
        >
          <IconSparkle16 size={16} />
        </button>
      </Tooltip>
    </span>
  );
}

const resourceUrls = new Map<string, Promise<string>>();

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

function MediaThumbnail({ attachment, load, labels, onOpen }: {
  attachment: ImageAttachmentRef;
  load: ImageLoader;
  labels: ImageLabels;
  onOpen(url: string, alt: string): void;
}): React.ReactElement {
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<{ url?: string; failed?: boolean }>({});
  const alt = attachment.name ?? labels.image;
  React.useEffect(() => {
    let active = true;
    setState({});
    void load(attachment).then(
      (url) => { if (active) setState({ url }); },
      () => { if (active) setState({ failed: true }); },
    );
    return () => { active = false; };
  }, [attachment, attempt, load]);
  if (state.failed === true) {
    return (
      <button type="button" className="dsh-media-thumb dsh-media-retry" onClick={() => setAttempt((value) => value + 1)}>
        {labels.loadFailed}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="dsh-media-thumb"
      aria-label={alt}
      title={labels.open}
      disabled={state.url === undefined}
      onClick={() => { if (state.url !== undefined) onOpen(state.url, alt); }}
    >
      {state.url === undefined ? labels.loading : <img src={state.url} alt={alt} />}
    </button>
  );
}

function MediaGallery({ images, load, labels }: {
  images: readonly { attachment: ImageAttachmentRef }[];
  load: ImageLoader;
  labels: ImageLabels;
}): React.ReactElement | null {
  const [open, setOpen] = React.useState<{ url: string; alt: string }>();
  React.useEffect(() => {
    if (open === undefined) return undefined;
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(undefined);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);
  if (images.length === 0) return null;
  return (
    <>
      <div className="dsh-media-gallery" data-single={images.length === 1 ? 'true' : 'false'}>
        {images.map(({ attachment }) => (
          <MediaThumbnail
            key={String(attachment.attachmentId)}
            attachment={attachment}
            load={load}
            labels={labels}
            onOpen={(url, alt) => setOpen({ url, alt })}
          />
        ))}
      </div>
      {open !== undefined && (
        <div
          className="dsh-media-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={labels.lightbox.dialog}
          onClick={() => setOpen(undefined)}
        >
          <button type="button" className="dsh-media-lightbox-close" aria-label={labels.lightbox.close} onClick={() => setOpen(undefined)}>×</button>
          <img src={open.url} alt={open.alt} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </>
  );
}

function UserMediaNode({ node, loadImage, t }: ChatNodeProps): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const texts: string[] = [];
  const images: { attachment: ImageAttachmentRef }[] = [];
  const refs = new Map<string, string>();
  const rest: unknown[] = [];
  for (const block of node.data.content) {
    if (typeof block === 'object' && block !== null && !Array.isArray(block)
      && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      texts.push((block as { text: string }).text);
    } else if (isMediaImageBlock(block)) {
      images.push({ attachment: block.resource.attachment });
      refs.set(String(block.resource.attachment.attachmentId), block.resource.ref);
    } else if (typeof block === 'object' && block !== null && !Array.isArray(block)
      && (block as { type?: unknown }).type === 'image'
      && typeof (block as { attachment?: unknown }).attachment === 'object') {
      images.push({ attachment: (block as { attachment: ImageAttachmentRef }).attachment });
    } else {
      rest.push(block);
    }
  }
  const text = texts.join('');
  const refKey = JSON.stringify([...refs.entries()]);
  const loader = React.useCallback<ImageLoader>((attachment) => {
    const ref = refs.get(String(attachment.attachmentId));
    return ref === undefined ? loadImage(attachment) : loadReferencedImage(ref);
  }, [loadImage, refKey]);
  const labels = {
    image: t('image.label'),
    open: t('image.openOriginal'),
    openNamed: (label: string) => t('image.openOriginalLabel', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: { dialog: t('image.preview'), close: t('image.closePreview') },
  };
  const time = new Date(node.data.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const copy = (): void => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1000);
    });
  };
  return (
    <div className="dsh-media-user-row" data-time-hover-root>
      <div className="dsh-media-user-stack">
        <MediaGallery images={images} load={loader} labels={labels} />
        {(text !== '' || rest.length > 0) && (
          <div className="dsh-media-user-bubble">
            <MessageText text={text} />
            {rest.map((block, index) => (
              <JsonBlock
                key={index}
                label={t('message.extraBlock')}
                payload={block}
                truncatedLabel={(total) => t('json.truncated', { total })}
              />
            ))}
          </div>
        )}
      </div>
      <div className="dsh-media-user-actions">
        <span>{time}</span>
        <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
          <button type="button" className="dsh-media-user-action" aria-label={copied ? t('copied') : t('copy')} onClick={copy}>
            {copied ? <IconCheckOutline16 size={16} /> : <IconCopyOutline16 size={16} />}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function installPromptBridge(api: IApiClient): () => void {
  const sessions = api.sessions;
  const original = sessions.prompt;
  const wrapped: typeof sessions.prompt = async (payload, signal) => {
    if (!payload.content.some((part) => part.type === 'image')) return original(payload, signal);
    const models = await sessions.models({ sessionId: payload.sessionId }, signal);
    if (!models.result.ok) {
      return { rpcId: models.rpcId, result: models.result } as RpcResponse<{ accepted: true }>;
    }
    const response = await fetch(PROMPT_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, selection: models.result.value.current satisfies SessionModels['current'] }),
      signal,
    });
    const body = await jsonResponse<PromptEndpointResponse>(response);
    if (body.result === undefined) throw new Error(body.error ?? `HTTP ${String(response.status)}`);
    return { rpcId: RpcId(`media-${crypto.randomUUID()}`), result: body.result };
  };
  sessions.prompt = wrapped;
  return () => {
    if (sessions.prompt === wrapped) sessions.prompt = original;
  };
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(installStyles, 'dsh-media-blocks: client styles');
  ctx.effect(() => installPromptBridge(ctx.connection.api), 'dsh-media-blocks: image prompt bridge');
  ctx.effect(() => () => {
    for (const pending of resourceUrls.values()) void pending.then((url) => URL.revokeObjectURL(url));
    resourceUrls.clear();
  }, 'dsh-media-blocks: release object URLs');
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'dfy-media-image',
    order: 100,
  }, (props: InputProps) => <MediaImageButton {...props} />));
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'user',
    priority: -10,
    locale: 'conversation',
  }, (props: ChatNodeProps) => <UserMediaNode {...props} />));
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'steering',
    priority: -10,
    locale: 'conversation',
  }, (props: ChatNodeProps) => <UserMediaNode {...props} />));
}
