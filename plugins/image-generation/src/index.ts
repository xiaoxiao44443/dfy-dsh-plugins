/** Dedicated OpenAI-compatible image generation/editing route for DeepSeek Harness. */
import type { Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-fs';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-skill';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { GenericCallView, ToolResult, ToolRunContext } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import type MediaBlocks from '@dfy-plugins/dsh-media-blocks';
import {
  createOfficialImageBlock,
  decodeImageAttachmentRef,
  decodeSessionImageRef,
  detectImageMediaType,
  type SerializableImageAttachmentRef,
  type SessionImageRef,
} from '@dfy-plugins/image-protocol';
import {
  publishSessionImages,
  readSessionImage,
  type ResolveSessionDirectory,
  type SessionImageOwner,
} from '@dfy-plugins/image-protocol/session-storage';
import { dirname, isAbsolute } from 'node:path';

import {
  decodeImageBase64,
  IMAGE_GENERATION_SKILL_CONTENT,
  imageApiEndpoint,
  parseImageApiResponse,
  parseImageQuality,
  renderImageGenerationResult,
  validateImageSize,
  type GeneratedImageValue,
  type ImageGenerationValue,
  type ImageOperation,
  type ImageQuality,
} from './logic.js';

export const name = 'image-generation';
export const inject = ['tools', 'attachments', 'credentials', 'fs', 'skills', 'sessionPersistence'];

export interface Config {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  quality?: string;
  size?: string;
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().default(''),
  model: z.string().default(''),
  quality: z.string().default('auto'),
  size: z.string().default('auto'),
});

const SETTINGS_NS = 'dsh-image-generation' as SettingsNamespace;
const STATUS_API = '/api/dsh-image-generation/status';
const RESOURCE_API = '/api/dsh-image-generation/resource';
const TOOL_NAME = 'dfy_image_generate';
const SKILL_NAME = 'dfy-image-generation';
const VISION_TOOL_NAME = 'dfy_vision_analyze';
const IMAGE_API_KEY_REF = credentialRef('DFY_IMAGE_GENERATION_API_KEY');
const MAX_INPUT_IMAGES = 8;
const MAX_OUTPUT_IMAGES = 4;
const REQUEST_TIMEOUT_MS = 310_000;

interface ResolvedConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  quality: ImageQuality;
  size: string;
}

type Activation =
  | { status: 'disabled' | 'unconfigured' | 'checking' }
  | { status: 'active'; model: string; credentialSource: string }
  | { status: 'error'; message: string; toolAvailable: boolean };

interface InputImage {
  data: Uint8Array;
  mediaType: ImageMediaType;
  name: string;
}

interface ImagePresentationMeta {
  images: unknown[];
}

interface LegacyGeneratedImageValue {
  ref: string;
  attachment: SerializableImageAttachmentRef;
}

interface SessionImageBlock {
  type: 'dfy-session-image';
  version: 1;
  ref: string;
  image: SessionImageRef;
}

declare module '@deepseek-ai/dsh-llm' {
  interface ContentBlockMap {
    'dfy-session-image': SessionImageBlock;
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  return {
    enabled: config.enabled ?? false,
    baseUrl: config.baseUrl?.trim() ?? '',
    model: config.model?.trim() ?? '',
    quality: parseImageQuality(config.quality ?? 'auto'),
    size: validateImageSize(config.size ?? 'auto'),
  };
}

function completeConfig(config: ResolvedConfig): boolean {
  return config.baseUrl.length > 0 && config.model.length > 0;
}

function fileName(displayPath: string): string {
  return displayPath.split(/[\\/]/).filter(Boolean).at(-1) ?? 'image';
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function readWorkspaceImage(ctx: Context, exec: ToolRunContext, requestedPath: string): Promise<InputImage> {
  const cwd = exec.agent?.session.header.cwd;
  const target = await ctx.fs.resolve(requestedPath, {
    ...(cwd === undefined ? {} : { cwd }),
    signal: exec.signal,
  });
  const info = await ctx.fs.stat(target, exec.signal);
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
    throw new Error(`input image not found: ${target.displayPath}`);
  }
  if (info.type !== 'file') throw new Error(`input image is not a regular file: ${target.displayPath}`);
  const cap = ctx.attachments.imageLimits.maxImageBytes;
  if (info.size !== undefined && info.size > cap) throw new Error(`input image exceeds ${String(cap)} bytes`);
  const data = await ctx.fs.readBytes(target, exec.signal, cap);
  const mediaType = detectImageMediaType(data);
  if (mediaType === undefined || !ctx.attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new Error(`unsupported input image format: ${target.displayPath}`);
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
  return { data, mediaType, name: fileName(target.displayPath) };
}

function normalizeImageToken(token: string): string {
  const trimmed = token.trim();
  const quoted = /^(?:["']([A-Za-z0-9_-]+)["']|([A-Za-z0-9_-]+)["']|["']([A-Za-z0-9_-]+))$/.exec(trimmed);
  return quoted?.[1] ?? quoted?.[2] ?? quoted?.[3] ?? trimmed;
}

function currentSessionOwner(
  ctx: Context,
  exec: ToolRunContext,
  rememberedSessionDirs: Map<string, string>,
): SessionImageOwner {
  const agent = exec.agent;
  if (agent === undefined) throw new Error('image generation requires an active DSH session');
  const location = ctx.sessionPersistence.locate(agent.session.header);
  if (location === undefined || !isAbsolute(location.path)) {
    throw new Error('the configured session persistence backend does not expose a session-owned image directory');
  }
  const owner = { sessionId: String(agent.id), directory: dirname(location.path) };
  rememberedSessionDirs.set(owner.sessionId, owner.directory);
  return owner;
}

async function persistedSessionDirectory(
  ctx: Context,
  sessionId: string,
  rememberedSessionDirs: Map<string, string>,
  signal: AbortSignal,
): Promise<string | undefined> {
  const remembered = rememberedSessionDirs.get(sessionId);
  if (remembered !== undefined) return remembered;
  const headers = await ctx.sessionPersistence.list(signal);
  const header = headers.find((candidate) => String(candidate.id) === sessionId);
  if (header === undefined) return undefined;
  const location = ctx.sessionPersistence.locate(header);
  if (location === undefined || !isAbsolute(location.path)) return undefined;
  const directory = dirname(location.path);
  rememberedSessionDirs.set(sessionId, directory);
  return directory;
}

function sessionDirectoryResolver(
  ctx: Context,
  rememberedSessionDirs: Map<string, string>,
): ResolveSessionDirectory {
  return (sessionId, signal) => persistedSessionDirectory(ctx, sessionId, rememberedSessionDirs, signal);
}

async function readAttachmentImage(
  ctx: Context,
  exec: ToolRunContext,
  token: string,
  rememberedSessionDirs: Map<string, string>,
): Promise<InputImage> {
  const normalized = normalizeImageToken(token);
  let sessionRef: SessionImageRef | undefined;
  try { sessionRef = decodeSessionImageRef(normalized); } catch {}
  if (sessionRef !== undefined) {
    const stored = await readSessionImage(
      sessionRef,
      sessionDirectoryResolver(ctx, rememberedSessionDirs),
      exec.signal,
      ctx.attachments.imageLimits.maxImageBytes,
    );
    return {
      data: stored.data,
      mediaType: stored.ref.mediaType,
      name: stored.ref.name ?? `generated-${stored.ref.imageId.slice(0, 8)}.${imageExtension(stored.ref.mediaType)}`,
    };
  }
  const stored = await ctx.attachments.readImage(decodeImageAttachmentRef(normalized), exec.signal);
  return {
    data: stored.data,
    mediaType: stored.ref.mediaType,
    name: stored.ref.name ?? `attachment-${String(stored.ref.attachmentId).slice(-8)}.png`,
  };
}

async function resolveInputImages(
  ctx: Context,
  exec: ToolRunContext,
  refs: readonly string[],
  paths: readonly string[],
  rememberedSessionDirs: Map<string, string>,
): Promise<InputImage[]> {
  if (refs.length + paths.length > MAX_INPUT_IMAGES) {
    throw new Error(`at most ${String(MAX_INPUT_IMAGES)} input images are supported`);
  }
  const images = await Promise.all([
    ...refs.map((ref) => readAttachmentImage(ctx, exec, ref, rememberedSessionDirs)),
    ...paths.map((path) => readWorkspaceImage(ctx, exec, path)),
  ]);
  const total = images.reduce((sum, image) => sum + image.data.byteLength, 0);
  if (total > ctx.attachments.imageLimits.maxMessageImageBytes) {
    throw new Error(`input images exceed the ${String(ctx.attachments.imageLimits.maxMessageImageBytes)} byte limit`);
  }
  return images;
}

async function readLimitedResponse(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel();
    throw new Error(`image API response exceeds ${String(limit)} bytes`);
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`image API response exceeds ${String(limit)} bytes`);
    }
    chunks.push(chunk.value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

function apiErrorMessage(status: number, value: unknown): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const error = (value as Record<string, unknown>).error;
    if (typeof error === 'string' && error.length > 0) return `image API ${String(status)}: ${error}`;
    if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string' && message.length > 0) return `image API ${String(status)}: ${message}`;
    }
    const message = (value as Record<string, unknown>).message;
    if (typeof message === 'string' && message.length > 0) return `image API ${String(status)}: ${message}`;
  }
  return `image API request failed with HTTP ${String(status)}`;
}

async function fetchOutputImage(urlValue: string, signal: AbortSignal, limit: number): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error('image API returned an invalid image URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('image URL must use http or https');
  const response = await fetch(url, { signal, redirect: 'follow' });
  if (!response.ok) throw new Error(`generated image download failed with HTTP ${String(response.status)}`);
  return readLimitedResponse(response, limit);
}

function imageExtension(mediaType: ImageMediaType): string {
  return mediaType === 'image/jpeg' ? 'jpg' : mediaType.split('/')[1]!;
}

function generatedName(base: string | undefined, index: number, mediaType: ImageMediaType): string {
  const extension = imageExtension(mediaType);
  const cleaned = base?.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\.[A-Za-z0-9]+$/, '');
  const stem = cleaned === undefined || cleaned.length === 0
    ? `generated-${new Date().toISOString().replace(/[:.]/g, '-')}`
    : cleaned;
  return `${stem}${index === 0 ? '' : `-${String(index + 1)}`}.${extension}`;
}

async function requestImages(
  ctx: Context,
  exec: ToolRunContext,
  config: ResolvedConfig,
  rememberedSessionDirs: Map<string, string>,
  args: {
    prompt: string;
    inputImageRefs: readonly string[];
    inputFilePaths: readonly string[];
    quality?: string;
    size?: string;
    count?: number;
    outputName?: string;
  },
): Promise<ImageGenerationValue> {
  const prompt = args.prompt.trim();
  if (prompt.length === 0) throw new Error('prompt must be a non-empty string');
  const quality = args.quality === undefined ? config.quality : parseImageQuality(args.quality);
  const size = args.size === undefined ? config.size : validateImageSize(args.size);
  const count = args.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_OUTPUT_IMAGES) {
    throw new Error(`count must be an integer from 1 to ${String(MAX_OUTPUT_IMAGES)}`);
  }
  if (count > ctx.attachments.imageLimits.maxImagesPerMessage) {
    throw new Error(`this deployment accepts at most ${String(ctx.attachments.imageLimits.maxImagesPerMessage)} result images`);
  }
  const credential = await ctx.credentials.resolve(IMAGE_API_KEY_REF);
  if (credential === undefined) throw new Error('图像生成 API Key 尚未配置');
  const inputs = await resolveInputImages(
    ctx,
    exec,
    args.inputImageRefs,
    args.inputFilePaths,
    rememberedSessionDirs,
  );
  const operation: ImageOperation = inputs.length === 0 ? 'generate' : 'edit';
  let response: Response;
  if (operation === 'generate') {
    response = await fetch(imageApiEndpoint(config.baseUrl, operation), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.value}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: config.model, prompt, quality, size, n: count }),
      signal: exec.signal,
    });
  } else {
    const body = new FormData();
    body.set('model', config.model);
    body.set('prompt', prompt);
    body.set('quality', quality);
    body.set('size', size);
    body.set('n', String(count));
    for (const input of inputs) {
      body.append('image[]', new Blob([Buffer.from(input.data)], { type: input.mediaType }), input.name);
    }
    response = await fetch(imageApiEndpoint(config.baseUrl, operation), {
      method: 'POST',
      headers: { authorization: `Bearer ${credential.value}` },
      body,
      signal: exec.signal,
    });
  }
  const responseLimit = Math.ceil(ctx.attachments.imageLimits.maxImageBytes * 4 / 3) * count + 1_048_576;
  const responseBytes = await readLimitedResponse(response, responseLimit);
  let responseValue: unknown;
  try {
    responseValue = JSON.parse(Buffer.from(responseBytes).toString('utf8'));
  } catch {
    throw new Error(`image API returned invalid JSON with HTTP ${String(response.status)}`);
  }
  if (!response.ok) throw new Error(apiErrorMessage(response.status, responseValue));
  const items = parseImageApiResponse(responseValue);
  if (items.length > MAX_OUTPUT_IMAGES || items.length > ctx.attachments.imageLimits.maxImagesPerMessage) {
    throw new Error(`image API returned too many images: ${String(items.length)}`);
  }
  const outputData = await Promise.all(items.map(async (item) => {
    const data = item.b64Json === undefined
      ? await fetchOutputImage(item.url!, exec.signal, ctx.attachments.imageLimits.maxImageBytes)
      : decodeImageBase64(item.b64Json);
    if (data.byteLength > ctx.attachments.imageLimits.maxImageBytes) {
      throw new Error(`generated image exceeds ${String(ctx.attachments.imageLimits.maxImageBytes)} bytes`);
    }
    const mediaType = detectImageMediaType(data);
    if (mediaType === undefined || !ctx.attachments.imageLimits.mediaTypes.includes(mediaType)) {
      throw new Error('image API returned an unsupported image format');
    }
    return { data, mediaType };
  }));
  const outputBytes = outputData.reduce((sum, image) => sum + image.data.byteLength, 0);
  if (outputBytes > ctx.attachments.imageLimits.maxMessageImageBytes) {
    throw new Error(`generated images exceed the ${String(ctx.attachments.imageLimits.maxMessageImageBytes)} byte limit`);
  }
  const sessionInputs = outputData.map((image, index) => ({
    data: image.data,
    mediaType: image.mediaType,
    name: generatedName(args.outputName, index, image.mediaType),
  }));
  await Promise.all(sessionInputs.map((image) => ctx.attachments.validateImage(image)));
  const refs = await publishSessionImages(
    currentSessionOwner(ctx, exec, rememberedSessionDirs),
    sessionInputs,
    exec.signal,
  );
  return {
    operation,
    model: config.model,
    quality,
    size,
    images: refs.map((stored) => ({
      ref: stored.token,
      image: stored.ref,
    })),
  };
}

function imagePresentationMeta(value: ImageGenerationValue): NonNullable<ToolResult['meta']> {
  return { images: value.images } as unknown as NonNullable<ToolResult['meta']>;
}

function isPresentationMeta(value: unknown): value is ImagePresentationMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Array.isArray((value as { images?: unknown }).images);
}

function isSessionGeneratedImage(value: unknown): value is GeneratedImageValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<GeneratedImageValue>;
  return typeof candidate.ref === 'string'
    && typeof candidate.image === 'object'
    && candidate.image !== null
    && candidate.image.kind === 'dsh-session-image'
    && candidate.image.version === 1;
}

function isLegacyGeneratedImage(value: unknown): value is LegacyGeneratedImageValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<LegacyGeneratedImageValue>;
  return typeof candidate.ref === 'string'
    && typeof candidate.attachment === 'object'
    && candidate.attachment !== null;
}

function presentGeneratedImages(result: ToolResult) {
  if (result.isError || !isPresentationMeta(result.meta)) return undefined;
  const content: ContentBlock[] = result.meta.images.flatMap((image) => {
    if (isSessionGeneratedImage(image)) return [{
        type: 'dfy-session-image',
        version: 1,
        ref: image.ref,
        image: image.image,
      } satisfies SessionImageBlock];
    if (isLegacyGeneratedImage(image)) {
      return [createOfficialImageBlock(image.attachment as ImageAttachmentRef)];
    }
    return [];
  });
  if (content.length === 0) return undefined;
  return { card: 'generic' as const, content };
}

function createImageTool(ctx: Context, current: () => Config, rememberedSessionDirs: Map<string, string>) {
  return defineTool({
    name: TOOL_NAME,
    description: 'Generate or edit images with the configured dedicated image route. Before every call, load the dfy-image-generation Skill and follow it.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Clean image-generation or edit brief prepared according to the dfy-image-generation Skill.',
      },
      input_image_refs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Opaque image_ref tokens for edit/reference inputs. Omit for text-to-image generation.',
      },
      input_file_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workspace image paths for edit/reference inputs. Omit for text-to-image generation.',
      },
      quality: {
        type: 'string',
        enum: ['auto', 'low', 'medium', 'high'],
        description: 'Optional per-call quality override. Omit to use plugin settings.',
      },
      size: {
        type: 'string',
        description: 'Optional auto or WIDTHxHEIGHT override. Omit to use plugin settings.',
      },
      count: {
        type: 'integer',
        description: 'Number of alternatives, 1-4. Use 1 unless the user asks for variants.',
      },
      output_name: {
        type: 'string',
        description: 'Optional display filename stem for the generated session image.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operation: { type: 'string', required: true },
          model: { type: 'string', required: true },
          quality: { type: 'string', required: true },
          size: { type: 'string', required: true },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'string', required: true },
                image: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string', required: true },
                    version: { type: 'integer', required: true },
                    sessionId: { type: 'string', required: true },
                    imageId: { type: 'string', required: true },
                    mediaType: { type: 'string', required: true },
                    bytes: { type: 'integer', required: true },
                    width: { type: 'integer', required: true },
                    height: { type: 'integer', required: true },
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderImageGenerationResult(value as ImageGenerationValue) }],
      presentationMeta: (_args, value) => imagePresentationMeta(value as ImageGenerationValue),
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => requestImages(ctx, exec, resolveConfig(current()), rememberedSessionDirs, {
      prompt: args.prompt,
      inputImageRefs: args.input_image_refs ?? [],
      inputFilePaths: args.input_file_paths ?? [],
      ...(args.quality === undefined ? {} : { quality: args.quality }),
      ...(args.size === undefined ? {} : { size: args.size }),
      ...(args.count === undefined ? {} : { count: args.count }),
      ...(args.output_name === undefined ? {} : { outputName: args.output_name }),
    }),
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: 'DFY IMAGE GENERATE',
        kind: 'execute',
        rawInput: args.prompt,
        ...(args.input_file_paths === undefined
          ? {}
          : { locations: args.input_file_paths.map((path) => ({ path })) }),
      };
    },
    presentResult: (_args, result) => presentGeneratedImages(result),
  });
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

async function readJsonBody(req: Parameters<WebRoute['handler']>[0], limit = 16_384): Promise<unknown> {
  const declared = req.headers['content-length'];
  if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > limit) {
    req.resume();
    throw new Error('request body is too large');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > limit) throw new Error('request body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
}

export function apply(ctx: Context, entryConfig: Config): void {
  const rememberedSessionDirs = new Map<string, string>();
  let source = () => entryConfig;
  let activation: Activation = { status: 'unconfigured' };
  let generation = 0;
  let disposeTool: (() => void) | undefined;
  let disposeSkill: (() => void) | undefined;
  let disposeReferenceAdapter: (() => void) | undefined;

  const clearFeatures = (): void => {
    disposeSkill?.();
    disposeTool?.();
    disposeSkill = undefined;
    disposeTool = undefined;
  };

  const ensureFeatures = (): void => {
    if (disposeTool !== undefined && disposeSkill !== undefined) return;
    clearFeatures();
    try {
      disposeTool = ctx.tools.register(createImageTool(ctx, source, rememberedSessionDirs));
      disposeSkill = ctx.skills.register({
        name: SKILL_NAME,
        description: '先整理生图或图片编辑提示词，再通过独立图片模型生成结果。',
        source: 'runtime',
        content: IMAGE_GENERATION_SKILL_CONTENT,
        invocation: { modelInvocable: true, userInvocable: true },
      });
    } catch (error) {
      clearFeatures();
      throw error;
    }
  };

  const refresh = async (): Promise<void> => {
    const ticket = ++generation;
    let config: ResolvedConfig;
    try {
      config = resolveConfig(source());
    } catch (error) {
      clearFeatures();
      activation = { status: 'error', message: String(error), toolAvailable: false };
      return;
    }
    if (!completeConfig(config)) {
      clearFeatures();
      activation = { status: 'unconfigured' };
      return;
    }
    if (!config.enabled) {
      clearFeatures();
      activation = { status: 'disabled' };
      return;
    }
    activation = { status: 'checking' };
    try {
      imageApiEndpoint(config.baseUrl, 'generate');
      ensureFeatures();
      const info = await ctx.credentials.describe(IMAGE_API_KEY_REF);
      if (ticket !== generation) return;
      activation = info.configured
        ? { status: 'active', model: config.model, credentialSource: info.source ?? 'configured' }
        : { status: 'error', message: '图像生成 API Key 尚未配置', toolAvailable: true };
    } catch (error) {
      if (ticket !== generation) return;
      activation = { status: 'error', message: String(error), toolAvailable: disposeTool !== undefined };
    }
  };

  void refresh();
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(SETTINGS_NS, Config, { base: entryConfig });
    let latest = scope.get();
    source = () => latest;
    void refresh();
    scope.watch((next) => {
      latest = next;
      void refresh();
    });
  });

  ctx.on('credentials/reference-updated', (ref) => {
    if (ref === IMAGE_API_KEY_REF) void refresh();
  });

  ctx.inject(['mediaBlocks'], (mediaCtx) => {
    const target: MediaBlocks = mediaCtx.mediaBlocks;
    disposeReferenceAdapter?.();
    const disposeAdapter = target.registerReferenceAdapter('image', ({ block, options, supportsImages }) => {
      if (!options.tools?.some((tool) => tool.name === TOOL_NAME)) return undefined;
      if (!supportsImages && options.tools.some((tool) => tool.name === VISION_TOOL_NAME)) return undefined;
      if (block.resource.kind !== 'image') return undefined;
      const label = block.presentation?.name ?? block.resource.attachment.name ?? 'image';
      return [{
        type: 'text',
        text: `<image_generation_reference name="${escapeXmlAttribute(label)}"><image_ref>${block.resource.ref}</image_ref>The opaque reference can be passed to ${TOOL_NAME}. Before generating or editing, load the ${SKILL_NAME} Skill and follow it.</image_generation_reference>`,
      }];
    }, {
      prepare: async () => {
        const config = resolveConfig(source());
        if (!config.enabled || !completeConfig(config)) return false;
        if (disposeTool === undefined || disposeSkill === undefined) await refresh();
        return disposeTool !== undefined && disposeSkill !== undefined;
      },
    });
    disposeReferenceAdapter = disposeAdapter;
    mediaCtx.effect(() => () => {
      disposeAdapter();
      if (disposeReferenceAdapter === disposeAdapter) disposeReferenceAdapter = undefined;
    }, 'dsh-image-generation: media reference adapter');
  });

  ctx.inject(['webServer'], (webCtx) => {
    const statusRoute: WebRoute = {
      kind: 'exact',
      path: STATUS_API,
      async handler(req, res) {
        if (req.method === 'PUT') {
          try {
            const payload = await readJsonBody(req);
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
              return sendJson(res, 400, { error: '请求格式无效' });
            }
            const apiKey = (payload as Record<string, unknown>).apiKey;
            if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
              return sendJson(res, 400, { error: 'API Key 不能为空' });
            }
            await ctx.credentials.set(IMAGE_API_KEY_REF, apiKey.trim());
            await refresh();
            const credential = await ctx.credentials.describe(IMAGE_API_KEY_REF);
            return sendJson(res, 200, { activation, credential });
          } catch (error) {
            return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        if (activation.status === 'checking' || activation.status === 'error') await refresh();
        const credential = await ctx.credentials.describe(IMAGE_API_KEY_REF);
        sendJson(res, 200, { activation, credential });
      },
    };
    const resourceRoute: WebRoute = {
      kind: 'exact',
      path: RESOURCE_API,
      async handler(req, res) {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        try {
          const token = new URL(req.url ?? RESOURCE_API, 'http://localhost').searchParams.get('ref');
          if (token === null) throw new Error('缺少资源引用');
          const normalized = normalizeImageToken(token);
          let sessionRef: SessionImageRef | undefined;
          try { sessionRef = decodeSessionImageRef(normalized); } catch {}
          let stored: { data: Uint8Array; mediaType: ImageMediaType };
          if (sessionRef !== undefined) {
            const sessionImage = await readSessionImage(
              sessionRef,
              sessionDirectoryResolver(ctx, rememberedSessionDirs),
              new AbortController().signal,
              ctx.attachments.imageLimits.maxImageBytes,
            );
            stored = { data: sessionImage.data, mediaType: sessionImage.ref.mediaType };
          } else {
            const attachment = await ctx.attachments.readImage(decodeImageAttachmentRef(normalized));
            stored = { data: attachment.data, mediaType: attachment.ref.mediaType };
          }
          res.writeHead(200, {
            'content-type': stored.mediaType,
            'content-length': stored.data.byteLength,
            'cache-control': 'private, max-age=31536000, immutable',
          });
          res.end(Buffer.from(stored.data));
        } catch (error) {
          sendJson(res, 404, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    };
    webCtx.webServer.register(statusRoute);
    webCtx.webServer.register(resourceRoute);
  });

  ctx.effect(() => () => {
    generation += 1;
    disposeReferenceAdapter?.();
    disposeReferenceAdapter = undefined;
    clearFeatures();
  }, 'dsh-image-generation: dynamic tool and skill');
}
