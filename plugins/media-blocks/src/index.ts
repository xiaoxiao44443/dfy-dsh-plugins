/** Shared multimedia reference blocks for DeepSeek Harness. */
import { Context, Service } from '@deepseek-ai/cordis';
import {
  isImageAdmissionError,
  type ImageAttachmentRef,
  type ImageMediaType,
} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-agent';
import {
  createUserMessage,
  freezeMessage,
  isAgentLoopRequest,
  markAgentLoopRequest,
  type ContentBlock,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { detectImageMediaType } from '@dfy-plugins/image-protocol';

import { decodeMediaImageRef, encodeMediaImageRef } from './reference.js';

export { decodeMediaImageRef, encodeMediaImageRef } from './reference.js';
export { detectImageMediaType } from '@dfy-plugins/image-protocol';

export const MEDIA_BLOCK_TYPE = 'dfy-media';
export const MEDIA_PROMPT_API = '/api/dsh-media-blocks/prompt';
export const MEDIA_RESOURCE_API = '/api/dsh-media-blocks/resource';
export const MEDIA_STATUS_API = '/api/dsh-media-blocks/status';

/** Extensible resource vocabulary. Other plugins may merge additional kinds. */
export interface MediaResourceMap {
  image: {
    ref: string;
    attachment: ImageAttachmentRef;
  };
}

export type MediaResource = {
  [Kind in keyof MediaResourceMap]: { kind: Kind } & MediaResourceMap[Kind]
}[keyof MediaResourceMap];

/** Durable conversation block: metadata and an external resource reference, never raw bytes. */
export interface MediaBlock {
  type: typeof MEDIA_BLOCK_TYPE;
  version: 1;
  resource: MediaResource;
  presentation?: {
    name?: string;
    caption?: string;
    renderer?: string;
  };
}

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    'dfy-media': MediaBlock;
  }
}

export interface MediaReferenceAdapterContext {
  block: MediaBlock;
  options: GenerateOptions;
  /** Whether the parent model already receives the official image block. */
  supportsImages: boolean;
}

export type MediaReferenceAdapter = (
  context: MediaReferenceAdapterContext,
) => readonly ContentBlock[] | undefined;

export interface MediaReferenceAdapterOptions {
  /** Re-establish transient runtime dependencies before accepting a prompt. */
  prepare?: () => boolean | Promise<boolean>;
}

type MediaReferenceAdapterEntry = {
  adapter: MediaReferenceAdapter;
  prepare?: () => boolean | Promise<boolean>;
};

type MediaReferenceAdapterSource = MediaReferenceAdapter | readonly MediaReferenceAdapterEntry[];

declare module '@deepseek-ai/cordis' {
  interface Context {
    mediaBlocks: MediaBlocks;
  }
}

interface BrowserPromptPartText {
  type: 'text';
  text: string;
}

interface BrowserPromptPartImage {
  type: 'image';
  mediaType: ImageMediaType;
  data: string;
  name?: string;
}

type BrowserPromptPart = BrowserPromptPartText | BrowserPromptPartImage;

interface MediaPromptPayload {
  sessionId: string;
  mode: 'queue' | 'steer';
  content: BrowserPromptPart[];
  clientTimeZone?: string;
  selection: { provider: string; model: string };
}

interface MediaPromptDiagnostic {
  time: number;
  selection: { provider: string; model: string };
  images: Array<{
    bytes: number;
    declaredMediaType: ImageMediaType;
    detectedMediaType?: ImageMediaType;
    signature: string;
  }>;
  error?: { code: string; message: string };
}

class RequestTooLargeError extends Error {}

function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || typeof node !== 'object' || node instanceof AbortSignal || seen.has(node)) continue;
    seen.add(node);
    Object.freeze(node);
    pending.push(...Object.values(node));
  }
  return value;
}

function sendJson(res: Parameters<WebRoute['handler']>[1], status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readRequestBytes(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = req.headers['content-length'];
  if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > limit) {
    req.resume();
    throw new RequestTooLargeError();
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > limit) throw new RequestTooLargeError();
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks, bytes));
}

function decodeCanonicalBase64(data: string): Uint8Array {
  const decoded = Buffer.from(data, 'base64');
  if (data.length === 0 || decoded.toString('base64') !== data) {
    throw new Error('图片数据不是规范的 base64');
  }
  return new Uint8Array(decoded);
}

function isImageMediaType(value: unknown): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif';
}

function byteSignature(data: Uint8Array): string {
  return Buffer.from(data.subarray(0, 12)).toString('hex');
}

function parsePromptPayload(value: unknown): MediaPromptPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('请求格式无效');
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) throw new Error('sessionId 无效');
  if (record.mode !== 'queue' && record.mode !== 'steer') throw new Error('mode 无效');
  if (!Array.isArray(record.content) || record.content.length === 0) throw new Error('content 无效');
  if (typeof record.selection !== 'object' || record.selection === null || Array.isArray(record.selection)) {
    throw new Error('selection 无效');
  }
  const selection = record.selection as Record<string, unknown>;
  if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') throw new Error('selection 无效');
  const content: BrowserPromptPart[] = record.content.map((part) => {
    if (typeof part !== 'object' || part === null || Array.isArray(part)) throw new Error('content part 无效');
    const item = part as Record<string, unknown>;
    if (item.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text };
    if (item.type === 'image' && isImageMediaType(item.mediaType) && typeof item.data === 'string'
      && (item.name === undefined || typeof item.name === 'string')) {
      return {
        type: 'image',
        mediaType: item.mediaType,
        data: item.data,
        ...(typeof item.name === 'string' ? { name: item.name } : {}),
      };
    }
    throw new Error('content part 无效');
  });
  return {
    sessionId: record.sessionId,
    mode: record.mode,
    content,
    selection: { provider: selection.provider, model: selection.model },
    ...(typeof record.clientTimeZone === 'string' ? { clientTimeZone: record.clientTimeZone } : {}),
  };
}

function textFallback(block: MediaBlock): ContentBlock {
  const name = block.presentation?.name;
  const label = block.resource.kind === 'image' ? 'Image attachment' : 'Media attachment';
  return { type: 'text', text: `[${label}${name === undefined ? '' : `: ${name}`}]` };
}

function hasMediaBlock(content: readonly ContentBlock[]): boolean {
  return content.some((block) => block.type === MEDIA_BLOCK_TYPE
    || (block.type === 'tool-result' && hasMediaBlock(block.content)));
}

export function transformMediaContent(
  content: readonly ContentBlock[],
  supportsImages: boolean,
  options: GenerateOptions,
  adapters: ReadonlyMap<string, MediaReferenceAdapterSource>,
): { content: ContentBlock[]; changed: boolean } {
  let changed = false;
  const transformed: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === MEDIA_BLOCK_TYPE) {
      changed = true;
      const source = adapters.get(String(block.resource.kind));
      const candidates = source === undefined
        ? []
        : typeof source === 'function'
          ? [source]
          : source.map((entry) => entry.adapter);
      const adapted = candidates
        .map((adapter) => adapter({ block, options, supportsImages }))
        .find((candidate) => candidate !== undefined);
      if (block.resource.kind === 'image' && supportsImages) {
        transformed.push({ type: 'image', attachment: block.resource.attachment });
        if (adapted !== undefined) transformed.push(...adapted);
        continue;
      }
      transformed.push(...(adapted ?? [textFallback(block)]));
      continue;
    }
    if (block.type === 'tool-result' && hasMediaBlock(block.content)) {
      const nested = transformMediaContent(block.content, supportsImages, options, adapters);
      transformed.push({ ...block, content: nested.content });
      changed ||= nested.changed;
      continue;
    }
    transformed.push(block);
  }
  return { content: transformed, changed };
}

/** Registry and request-boundary adapter for durable multimedia blocks. */
export default class MediaBlocks extends Service {
  static inject = ['llm', 'attachments', 'agents'];
  readonly registerReferenceAdapter: (
    kind: string,
    adapter: MediaReferenceAdapter,
    options?: MediaReferenceAdapterOptions,
  ) => () => void;
  readonly hasReferenceAdapter: (kind: string) => boolean;
  readonly prepareReferenceAdapter: (kind: string) => Promise<boolean>;
  readonly status: () => {
    instanceId: string;
    referenceAdapters: string[];
    lastPrompt?: MediaPromptDiagnostic;
  };

  constructor(ctx: Context) {
    super(ctx, 'mediaBlocks');

    // Cordis intentionally rebinds service methods to the caller's context.
    // Keep identity-sensitive registry state in this constructor closure so a
    // dependent plugin and this Host's routes always mutate/read the same Map.
    const instanceId = randomUUID();
    const adapters = new Map<string, MediaReferenceAdapterEntry[]>();
    let lastPrompt: MediaPromptDiagnostic | undefined;
    this.registerReferenceAdapter = (kind, adapter, options = {}) => {
      if (kind.length === 0) throw new Error('media block adapter kind cannot be empty');
      const entry: MediaReferenceAdapterEntry = {
        adapter,
        ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
      };
      const entries = adapters.get(kind) ?? [];
      entries.push(entry);
      adapters.set(kind, entries);
      return () => {
        const current = adapters.get(kind);
        if (current === undefined) return;
        const index = current.indexOf(entry);
        if (index === -1) return;
        current.splice(index, 1);
        if (current.length === 0) adapters.delete(kind);
      };
    };
    this.hasReferenceAdapter = (kind) => adapters.has(kind);
    this.prepareReferenceAdapter = async (kind) => {
      if (!adapters.has(kind)) return false;
      const entries = adapters.get(kind);
      if (entries === undefined) return false;
      for (const entry of entries) {
        if (entry.prepare === undefined) return true;
        try {
          if (await entry.prepare()) return true;
        } catch {
          // Another adapter for the same resource kind may still be available.
        }
      }
      return false;
    };
    this.status = () => ({
      instanceId,
      referenceAdapters: [...adapters.keys()].sort(),
      ...(lastPrompt === undefined ? {} : { lastPrompt }),
    });

    // A durable media block is deliberately not a provider block. Resolve it
    // only at the final LLM boundary, then enter the adapter without recursively
    // dispatching the same waterfall listener.
    ctx.on('llm/stream', function resolveMediaReferences(options, next): AsyncIterable<StreamChunk> {
      if (!options.messages.some((message) => hasMediaBlock(message.content))) return next();
      const runtime = this as unknown as {
        resolveModelInfo: typeof ctx.llm.resolveModelInfo;
        adapterStream(projected: GenerateOptions): AsyncIterable<StreamChunk>;
      };
      return (async function* () {
        const info = await runtime.resolveModelInfo(options.provider, options.model, options.signal);
        const supportsImages = info.inputModalities?.includes('image') === true;
        let changed = false;
        const messages: Message[] = options.messages.map((message) => {
          const transformed = transformMediaContent(message.content, supportsImages, options, adapters);
          changed ||= transformed.changed;
          return transformed.changed ? freezeMessage({ ...message, content: transformed.content }) : message;
        });
        let projected = changed ? { ...options, messages } : options;
        if (changed && isAgentLoopRequest(options)) {
          projected = markAgentLoopRequest(deepFreeze(projected));
        }
        yield* runtime.adapterStream(projected);
      })();
    });

    ctx.inject(['webServer'], (webCtx) => {
      const promptRoute: WebRoute = {
        kind: 'exact',
        path: MEDIA_PROMPT_API,
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
          let diagnostic: MediaPromptDiagnostic | undefined;
          try {
            const requestLimit = Math.ceil(ctx.attachments.imageLimits.maxMessageImageBytes * 4 / 3) + 1_048_576;
            const raw = await readRequestBytes(req, requestLimit);
            const payload = parsePromptPayload(JSON.parse(Buffer.from(raw).toString('utf8')));
            const agent = ctx.agents.get(SessionId(payload.sessionId));
            if (agent === undefined) {
              return sendJson(res, 404, {
                result: { ok: false, error: { code: 'session-not-found', message: '会话不存在或尚未连接', details: { sessionId: payload.sessionId } } },
              });
            }
            const modelInfo = await ctx.llm.resolveModelInfo(payload.selection.provider, payload.selection.model);
            const explicitlyTextOnly = modelInfo.inputModalities !== undefined
              && !modelInfo.inputModalities.includes('image');
            if (explicitlyTextOnly && !(await this.prepareReferenceAdapter('image'))) {
              return sendJson(res, 409, {
                result: {
                  ok: false,
                  error: {
                    code: 'attachment-error',
                    message: `Model "${payload.selection.model}" does not support image input.`,
                    details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
                  },
                },
              });
            }
            const prepared = payload.content.map((part) => part.type === 'text'
              ? part
              : (() => {
                const data = decodeCanonicalBase64(part.data);
                return { part, data, detectedMediaType: detectImageMediaType(data) };
              })());
            const images = prepared.filter((part): part is Extract<typeof part, { data: Uint8Array }> => 'data' in part);
            diagnostic = {
              time: Date.now(),
              selection: payload.selection,
              images: images.map((image) => ({
                bytes: image.data.byteLength,
                declaredMediaType: image.part.mediaType,
                ...(image.detectedMediaType === undefined ? {} : { detectedMediaType: image.detectedMediaType }),
                signature: byteSignature(image.data),
              })),
            };
            lastPrompt = diagnostic;
            const refs = await ctx.attachments.saveImages(images.map((image) => ({
              data: image.data,
              mediaType: image.detectedMediaType ?? image.part.mediaType,
              ...(image.part.name === undefined ? {} : { name: image.part.name }),
            })));
            let imageIndex = 0;
            const content: ContentBlock[] = prepared.map((part) => {
              if (!('data' in part)) return { type: 'text', text: part.text };
              const attachment = refs[imageIndex++];
              if (attachment === undefined) throw new Error('附件保存结果数量不一致');
              const block: MediaBlock = {
                type: MEDIA_BLOCK_TYPE,
                version: 1,
                resource: {
                  kind: 'image',
                  ref: encodeMediaImageRef(attachment),
                  attachment,
                },
                presentation: { ...(attachment.name === undefined ? {} : { name: attachment.name }) },
              };
              return block;
            });
            const message = createUserMessage({ content, source: { kind: 'user' } });
            if (payload.mode === 'steer') agent.steer(message);
            else agent.followup(message);
            sendJson(res, 200, { result: { ok: true, value: { accepted: true } } });
          } catch (error) {
            const errorCode = isImageAdmissionError(error) ? error.code : 'MEDIA_PROMPT_INVALID';
            if (diagnostic !== undefined) {
              diagnostic.error = {
                code: errorCode,
                message: error instanceof Error ? error.message : String(error),
              };
              lastPrompt = diagnostic;
            }
            if (error instanceof RequestTooLargeError) {
              return sendJson(res, 413, {
                result: { ok: false, error: { code: 'attachment-error', message: '图片总大小超过限制', details: { reason: 'IMAGES_TOO_LARGE' } } },
              });
            }
            sendJson(res, 400, {
              result: {
                ok: false,
                error: {
                  code: 'attachment-error',
                  message: error instanceof Error ? error.message : String(error),
                  details: { reason: errorCode },
                },
              },
            });
          }
        },
      };
      const resourceRoute: WebRoute = {
        kind: 'exact',
        path: MEDIA_RESOURCE_API,
        handler: async (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
          try {
            const token = new URL(req.url ?? MEDIA_RESOURCE_API, 'http://localhost').searchParams.get('ref');
            if (token === null) throw new Error('缺少资源引用');
            const stored = await ctx.attachments.readImage(decodeMediaImageRef(token));
            res.writeHead(200, {
              'content-type': stored.ref.mediaType,
              'content-length': stored.data.byteLength,
              'cache-control': 'private, max-age=31536000, immutable',
            });
            res.end(Buffer.from(stored.data));
          } catch (error) {
            sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
          }
        },
      };
      const statusRoute: WebRoute = {
        kind: 'exact',
        path: MEDIA_STATUS_API,
        handler: (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
          sendJson(res, 200, this.status());
        },
      };
      webCtx.webServer.register(promptRoute);
      webCtx.webServer.register(resourceRoute);
      webCtx.webServer.register(statusRoute);
    });
  }

}
