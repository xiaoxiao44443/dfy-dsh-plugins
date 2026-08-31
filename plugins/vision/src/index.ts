/** @dfy-plugins/dsh-vision Host half: isolated visual inference, tool, Skill, settings, and route discovery. */
import type { Context } from '@deepseek-ai/cordis';
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-fs';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-skill';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { GenericCallView, ToolResult, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type { IncomingMessage } from 'node:http';
import z from '@deepseek-ai/schemastery';
import type MediaBlocks from '@dfy-plugins/dsh-media-blocks';
import {
  decodeResourceReference,
  getProcessResourceRegistry,
} from '@dfy-plugins/resource-core';
import {
  createOfficialImageBlock,
  decodeSessionImageRef,
  detectImageMediaType,
} from '@dfy-plugins/image-protocol';
import {
  readSessionImage,
  type ResolveSessionDirectory,
} from '@dfy-plugins/image-protocol/session-storage';
import { dirname, isAbsolute } from 'node:path';

import {
  collectVisionImageSources,
  decodeImageRef,
  encodeImageRef,
  imageMediaTypeForPath,
  renderVisionResult,
  textFromBlocks,
  visionConfigurationUnavailable,
  visionModelUnsupported,
  VISION_SKILL_CONTENT,
  VISION_SYSTEM_PROMPT,
  VISION_TOOL_DESCRIPTION,
  type VisionUnavailableState,
  type VisionImageSourceInput,
  type VisionResultValue,
} from './logic.js';

export const name = 'vision';
export const inject = ['llm', 'tools', 'fs', 'attachments', 'skills', 'sessionPersistence'];

export interface Config {
  enabled?: boolean;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().default(''),
  model: z.string().default(''),
  reasoningEffort: z.string().default(''),
  maxTokens: z.number().step(1).min(64).max(8192).default(1024),
});

const SETTINGS_NS = 'dsh-vision' as SettingsNamespace;
const API_PATH = '/api/dsh-vision/routes';
const RESOURCE_API_PATH = '/api/dsh-vision/resource';
const TOOL_NAME = 'dfy_vision_analyze';
const SKILL_NAME = 'dfy-vision';
const DEFAULT_MAX_TOKENS = 1024;

interface ResolvedConfig {
  enabled: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
  maxTokens: number;
}

type Activation =
  | VisionUnavailableState
  | { status: 'checking' }
  | { status: 'active'; provider: string; model: string }
  | { status: 'error'; message: string };

interface VisionModelView {
  id: string;
  name: string;
  reasoning?: {
    efforts: { id: string; name: string; description?: string }[];
    defaultEffort?: string;
  };
}

interface VisionProviderView {
  id: string;
  name: string;
  models: VisionModelView[];
}

interface ResolvedToolImage {
  label: string;
  ref: ImageAttachmentRef;
}

class UploadTooLargeError extends Error {}

function requestImageMediaType(req: IncomingMessage): ImageMediaType | undefined {
  const header = req.headers['content-type'];
  const value = (Array.isArray(header) ? header[0] : header)?.split(';', 1)[0]?.trim().toLowerCase();
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif') return value;
  return undefined;
}

function requestImageName(req: IncomingMessage): string | undefined {
  const header = req.headers['x-dsh-vision-name'];
  const encoded = Array.isArray(header) ? header[0] : header;
  if (encoded === undefined || encoded.length === 0) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

async function readRequestBytes(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  const declared = req.headers['content-length'];
  if (typeof declared === 'string' && /^\d+$/.test(declared) && Number(declared) > limit) {
    req.resume();
    throw new UploadTooLargeError();
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > limit) throw new UploadTooLargeError();
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks, bytes));
}

function resolvedConfig(config: Config): ResolvedConfig {
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  return {
    enabled: config.enabled ?? false,
    provider: config.provider?.trim() ?? '',
    model: config.model?.trim() ?? '',
    reasoningEffort: config.reasoningEffort?.trim() ?? '',
    maxTokens: Number.isSafeInteger(maxTokens) && maxTokens >= 64 && maxTokens <= 8192
      ? maxTokens
      : DEFAULT_MAX_TOKENS,
  };
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

async function saveToolImage(
  ctx: Context,
  exec: ToolRunContext,
  requestedPath: string,
): Promise<ResolvedToolImage> {
  const mediaType = imageMediaTypeForPath(requestedPath);
  if (mediaType === undefined) {
    throw new Error(`cannot analyze "${requestedPath}": expected a PNG, JPEG, WebP, or GIF image path`);
  }
  if (!ctx.attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new Error(`cannot analyze "${requestedPath}": ${mediaType} is disabled by this deployment`);
  }
  const cwd = exec.agent?.session.header.cwd;
  const target = await ctx.fs.resolve(requestedPath, {
    ...(cwd === undefined ? {} : { cwd }),
    signal: exec.signal,
  });
  const info = await ctx.fs.stat(target, exec.signal);
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
    throw new Error(`cannot analyze "${target.displayPath}": file not found`);
  }
  if (info.type !== 'file') throw new Error(`cannot analyze "${target.displayPath}": not a regular file`);

  const byteCap = Math.min(
    ctx.attachments.imageLimits.maxImageBytes,
    ctx.attachments.imageLimits.maxMessageImageBytes,
  );
  if (info.size !== undefined && info.size > byteCap) {
    throw new Error(`cannot analyze "${target.displayPath}": image exceeds the ${String(byteCap)} byte limit`);
  }
  const data = await ctx.fs.readBytes(target, exec.signal, byteCap);
  const ref = await ctx.attachments.saveImage({ data, mediaType, name: fileName(target.displayPath) });
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
  return { label: target.displayPath, ref };
}

function normalizeImageToken(token: string): string {
  const trimmed = token.trim();
  const quoted = /^(?:["']([A-Za-z0-9_-]+)["']|([A-Za-z0-9_-]+)["']|["']([A-Za-z0-9_-]+))$/.exec(trimmed);
  return quoted?.[1] ?? quoted?.[2] ?? quoted?.[3] ?? trimmed;
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

export async function readReferencedImage(
  ctx: Context,
  exec: ToolRunContext,
  imageRef: string,
  rememberedSessionDirs: Map<string, string>,
): Promise<ResolvedToolImage> {
  const normalized = normalizeImageToken(imageRef);
  let sessionRef: ReturnType<typeof decodeSessionImageRef> | undefined;
  try { sessionRef = decodeSessionImageRef(normalized); } catch {}
  if (sessionRef !== undefined) {
    const stored = await readSessionImage(
      sessionRef,
      sessionDirectoryResolver(ctx, rememberedSessionDirs),
      exec.signal,
      Math.min(ctx.attachments.imageLimits.maxImageBytes, ctx.attachments.imageLimits.maxMessageImageBytes),
    );
    // Visual-model adapters consume official Attachment refs. Once a generated
    // result is explicitly used as vision input, admit it through that official
    // boundary while keeping the session artifact as its canonical output copy.
    const ref = await ctx.attachments.saveImage({
      data: stored.data,
      mediaType: stored.ref.mediaType,
      ...(stored.ref.name === undefined ? {} : { name: stored.ref.name }),
    });
    return {
      label: `generated:${stored.ref.name ?? stored.ref.imageId.slice(0, 8)}`,
      ref,
    };
  }
  const ref = decodeImageRef(normalized);
  const stored = await ctx.attachments.readImage(ref, exec.signal);
  // Re-admit durable references created by older Harness versions so rc.2 can
  // normalize their pixels before deriving a provider-specific request image.
  const admitted = await ctx.attachments.saveImage({
    data: stored.data,
    mediaType: stored.ref.mediaType,
    ...(stored.ref.name === undefined ? {} : { name: stored.ref.name }),
  });
  return {
    label: admitted.name === undefined ? String(admitted.attachmentId) : `attachment:${admitted.name}`,
    ref: admitted,
  };
}

export async function readResourceImage(
  ctx: Context,
  exec: ToolRunContext,
  resourceRef: string,
): Promise<ResolvedToolImage> {
  const token = resourceRef.trim();
  const reference = decodeResourceReference(token);
  const resource = await getProcessResourceRegistry().resolve(token, 'image', exec.signal);
  if (resource.data === undefined) throw new Error('image resource does not expose in-process bytes');
  const byteCap = Math.min(
    ctx.attachments.imageLimits.maxImageBytes,
    ctx.attachments.imageLimits.maxMessageImageBytes,
  );
  if (resource.data.byteLength === 0 || resource.data.byteLength > byteCap) {
    throw new Error(`image resource exceeds the ${String(byteCap)} byte limit`);
  }
  const mediaType = detectImageMediaType(resource.data);
  if (mediaType === undefined || !ctx.attachments.imageLimits.mediaTypes.includes(mediaType)) {
    throw new Error('image resource has an unsupported or mismatched format');
  }
  if (resource.mediaType !== undefined && resource.mediaType !== mediaType) {
    throw new Error('image resource media type does not match its bytes');
  }
  const name = typeof resource.name === 'string' && resource.name.length > 0
    ? resource.name.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 255)
    : `browser-screenshot-${reference.id.slice(0, 8)}.png`;
  const ref = await ctx.attachments.saveImage({ data: resource.data, mediaType, name });
  return { label: `resource:${reference.provider}/${reference.id}`, ref };
}

async function analyzeImages(
  ctx: Context,
  exec: ToolRunContext,
  config: ResolvedConfig,
  rememberedSessionDirs: Map<string, string>,
  source: VisionImageSourceInput,
  question: string,
): Promise<VisionResultValue> {
  const prompt = question.trim();
  if (prompt.length === 0) throw new Error('question must be a non-empty string');
  const sources = collectVisionImageSources(source, ctx.attachments.imageLimits.maxImagesPerMessage);
  const modelInfo = await ctx.llm.resolveModelInfo(config.provider, config.model, exec.signal);
  const unsupported = visionModelUnsupported(config.provider, config.model, modelInfo.inputModalities);
  if (unsupported !== undefined) throw new Error(unsupported.message);
  const images: ResolvedToolImage[] = [];
  for (const item of sources) {
    if (item.kind === 'file') images.push(await saveToolImage(ctx, exec, item.value));
    else if (item.kind === 'attachment') {
      images.push(await readReferencedImage(ctx, exec, item.value, rememberedSessionDirs));
    }
    else images.push(await readResourceImage(ctx, exec, item.value));
  }

  const message = createUserMessage({
    source: { kind: 'plugin', plugin: '@dfy-plugins/dsh-vision' },
    content: [
      { type: 'text', text: prompt },
      ...images.map((image) => ({ type: 'image' as const, attachment: image.ref })),
    ],
  });
  const assembler = new BlockAssembler();
  for await (const chunk of ctx.llm.stream({
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort.length === 0 ? {} : { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }),
    messages: [message],
    system: VISION_SYSTEM_PROMPT,
    maxTokens: config.maxTokens,
    signal: exec.signal,
  })) {
    assembler.push(chunk);
  }
  const finish = assembler.finish;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`visual model call failed (${finish.failure.code}): ${finish.failure.message}`);
  }
  const analysis = textFromBlocks(assembler.blocks());
  if (analysis.length === 0) throw new Error('visual model returned no text analysis');
  return {
    provider: config.provider,
    model: config.model,
    analysis,
    finishReason: finish.kind,
    images: images.map((image) => ({
      path: image.label,
      imageRef: encodeImageRef(image.ref),
      image: {
        mediaType: image.ref.mediaType,
        bytes: image.ref.bytes,
        width: image.ref.width,
        height: image.ref.height,
      },
    })),
  };
}

interface LegacyVisionPresentationMeta {
  version: 1;
  imageRef: string;
}

interface VisionPresentationMeta {
  version: 2;
  imageRefs: string[];
}

function visionPresentationMeta(value: VisionResultValue): NonNullable<ToolResult['meta']> {
  return { version: 2, imageRefs: value.images.map((image) => image.imageRef) };
}

function isVisionPresentationMeta(value: unknown): value is LegacyVisionPresentationMeta | VisionPresentationMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const meta = value as { version?: unknown; imageRef?: unknown; imageRefs?: unknown };
  if (meta.version === 1) return typeof meta.imageRef === 'string';
  return meta.version === 2
    && Array.isArray(meta.imageRefs)
    && meta.imageRefs.length > 0
    && meta.imageRefs.every((item: unknown) => typeof item === 'string');
}

function presentVisionResult(result: ToolResult) {
  if (result.isError || !isVisionPresentationMeta(result.meta)) return undefined;
  try {
    const imageRefs = result.meta.version === 1 ? [result.meta.imageRef] : result.meta.imageRefs;
    const attachments = imageRefs.map((imageRef) => decodeImageRef(imageRef));
    return {
      card: 'generic' as const,
      content: [...result.content, ...attachments.map((attachment) => createOfficialImageBlock(attachment))],
    };
  } catch {
    // A stale or malformed presentation reference must not replace the readable
    // model-facing text fallback during replay.
    return undefined;
  }
}

function createVisionTool(ctx: Context, current: () => Config, rememberedSessionDirs: Map<string, string>) {
  return defineTool({
    name: TOOL_NAME,
    description: VISION_TOOL_DESCRIPTION,
    parameters: {
      file_path: {
        type: 'string',
        description: 'Single workspace image path retained for compatibility. Prefer file_paths for a batch.',
      },
      file_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Workspace image paths to analyze together in one visual-model call.',
      },
      image_ref: {
        type: 'string',
        description: 'Single opaque uploaded-attachment or generated-session-image token retained for compatibility. Prefer image_refs for a batch.',
      },
      image_refs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Opaque uploaded-attachment or generated-session-image tokens copied from all relevant <image_ref> values and analyzed together in one call.',
      },
      resource_ref: {
        type: 'string',
        description: 'Single opaque browser resourceRef retained for compatibility. Prefer resource_refs for a batch.',
      },
      resource_refs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Opaque browser resourceRef values to analyze together in one visual-model call.',
      },
      question: {
        type: 'string',
        required: true,
        description: 'Focused question for the visual model, including desired UI details or coordinates.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          analysis: { type: 'string', required: true },
          finishReason: { type: 'string', required: true },
          images: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                imageRef: { type: 'string', required: true },
                image: {
                  type: 'object',
                  required: true,
                  additionalProperties: false,
                  properties: {
                    mediaType: { type: 'string', required: true },
                    bytes: { type: 'integer', required: true },
                    width: { type: 'integer', required: true },
                    height: { type: 'integer', required: true },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderVisionResult(value as VisionResultValue) }],
      presentationMeta: (_args, value) => visionPresentationMeta(value as VisionResultValue),
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => analyzeImages(ctx, exec, resolvedConfig(current()), rememberedSessionDirs, {
      ...(args.file_path === undefined ? {} : { filePath: args.file_path }),
      ...(args.file_paths === undefined ? {} : { filePaths: args.file_paths }),
      ...(args.image_ref === undefined ? {} : { imageRef: args.image_ref }),
      ...(args.image_refs === undefined ? {} : { imageRefs: args.image_refs }),
      ...(args.resource_ref === undefined ? {} : { resourceRef: args.resource_ref }),
      ...(args.resource_refs === undefined ? {} : { resourceRefs: args.resource_refs }),
    }, args.question),
    presentCall(args): GenericCallView {
      const locations = [
        ...(args.file_path === undefined ? [] : [{ path: args.file_path }]),
        ...(args.file_paths ?? []).map((path) => ({ path })),
      ];
      return {
        card: 'generic',
        title: 'DFY VISION ANALYZE',
        kind: 'read',
        ...(locations.length === 0 ? {} : { locations }),
      };
    },
    presentResult: (_args, result) => presentVisionResult(result),
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

async function listVisionProviders(ctx: Context, current: ResolvedConfig): Promise<VisionProviderView[]> {
  const providers: VisionProviderView[] = [];
  for (const provider of ctx.llm.listProviders()) {
    let catalog: LlmModelInfo[];
    try {
      catalog = await ctx.llm.listModels(provider.id);
    } catch {
      catalog = [];
    }
    const models: VisionModelView[] = [];
    for (const model of catalog) {
      try {
        const exact = await ctx.llm.resolveModelInfo(provider.id, model.id);
        if (exact.inputModalities?.includes('image')) models.push(visionModelView(exact));
      } catch {
        if (model.inputModalities?.includes('image')) models.push({ id: model.id, name: model.name });
      }
    }
    if (provider.id === current.provider && current.model.length > 0 && !models.some((model) => model.id === current.model)) {
      try {
        const exact = await ctx.llm.resolveModelInfo(provider.id, current.model);
        if (exact.inputModalities?.includes('image')) models.push(visionModelView(exact));
      } catch {
        // A stale configured route is represented by activation, not as a selectable model.
      }
    }
    if (models.length > 0) providers.push({ id: provider.id, name: provider.name, models });
  }
  return providers;
}

function visionModelView(model: LlmResolvedModelInfo): VisionModelView {
  return {
    id: model.id,
    name: model.name,
    ...(model.reasoning === undefined ? {} : {
      reasoning: {
        efforts: model.reasoning.efforts.map((effort) => ({
          id: effort.id,
          name: effort.name,
          ...(effort.description === undefined ? {} : { description: effort.description }),
        })),
        ...(model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
      },
    }),
  };
}

export function apply(ctx: Context, entryConfig: Config): void {
  const rememberedSessionDirs = new Map<string, string>();
  let source = () => entryConfig;
  let activation: Activation = { status: 'unconfigured', message: '尚未配置视觉提供方和模型，视觉分析不可用' };
  let generation = 0;
  let disposeTool: (() => void) | undefined;
  let disposeSkill: (() => void) | undefined;
  let disposeReferenceAdapter: (() => void) | undefined;
  let mediaBlocks: MediaBlocks | undefined;
  let mediaBinding: symbol | undefined;

  const clearRuntimeFeatures = (): void => {
    disposeSkill?.();
    disposeTool?.();
    disposeSkill = undefined;
    disposeTool = undefined;
  };

  const ensureFeatures = (): void => {
    if (disposeSkill !== undefined && disposeTool !== undefined) return;
    clearRuntimeFeatures();
    try {
      disposeTool = ctx.tools.register(createVisionTool(ctx, source, rememberedSessionDirs));
      disposeSkill = ctx.skills.register({
        name: SKILL_NAME,
        description: '使用独立视觉模型分析图片或界面截图，并把文本观察返回给当前文本模型。',
        source: 'runtime',
        content: VISION_SKILL_CONTENT,
        invocation: { modelInvocable: true, userInvocable: true },
      });
    } catch (error) {
      clearRuntimeFeatures();
      throw error;
    }
  };

  const refresh = async (): Promise<void> => {
    const ticket = ++generation;
    const config = resolvedConfig(source());
    const unavailable = visionConfigurationUnavailable(config);
    if (unavailable !== undefined) {
      clearRuntimeFeatures();
      activation = unavailable;
      return;
    }
    // Sessions snapshot their available Skills and tools when they are created.
    // Register a configured route before the asynchronous model probe so a
    // conversation opened during desktop startup does not permanently miss
    // vision. Execution still resolves the model again, and a failed probe
    // below promptly removes both registrations.
    try {
      ensureFeatures();
    } catch (error) {
      activation = { status: 'error', message: String(error) };
      return;
    }
    activation = { status: 'checking' };
    try {
      const modelInfo = await ctx.llm.resolveModelInfo(config.provider, config.model);
      if (ticket !== generation) return;
      const unsupported = visionModelUnsupported(config.provider, config.model, modelInfo.inputModalities);
      if (unsupported !== undefined) {
        clearRuntimeFeatures();
        activation = unsupported;
        return;
      }
      if (config.reasoningEffort.length > 0
        && !modelInfo.reasoning?.efforts.some((effort) => effort.id === config.reasoningEffort)) {
        clearRuntimeFeatures();
        activation = { status: 'error', message: `${config.provider}/${config.model} 不支持推理等级 ${config.reasoningEffort}` };
        return;
      }
      try {
        // Model and settings refreshes are asynchronous. Retain the current
        // working registrations while validation is in flight so switching a
        // chat model cannot create a transient VISION_ROUTE_UNAVAILABLE gap.
        ensureFeatures();
        activation = { status: 'active', provider: config.provider, model: config.model };
      } catch (error) {
        activation = { status: 'error', message: String(error) };
      }
    } catch (error) {
      if (ticket !== generation) return;
      activation = { status: 'error', message: String(error) };
    }
  };

  // Keep bundle order irrelevant: vision may be listed before media-blocks in
  // an existing Profile. Cordis reruns this scoped callback when the service
  // appears and disposes the adapter if it disappears.
  ctx.inject(['mediaBlocks'], (mediaCtx) => {
    const target = mediaCtx.mediaBlocks;
    const binding = Symbol('dsh-vision:media-blocks');
    mediaBinding = binding;
    disposeReferenceAdapter?.();
    mediaBlocks = target;
    disposeReferenceAdapter = target.registerReferenceAdapter('image', ({ block, options, supportsImages }) => {
      if (supportsImages) return undefined;
      if (options.purpose !== undefined) return undefined;
      if (!options.tools?.some((tool) => tool.name === TOOL_NAME)) return undefined;
      if (block.resource.kind !== 'image') return undefined;
      const name = block.presentation?.name ?? block.resource.attachment.name ?? 'image';
      return [{
        type: 'text',
        text: `<vision_image name="${escapeXmlAttribute(name)}"><image_ref>${block.resource.ref}</image_ref>The image pixels are stored outside this text context. Before visual analysis, load the ${SKILL_NAME} Skill. If the prompt contains multiple vision_image blocks, collect all relevant image_ref values into one image_refs array and call the vision tool once, then answer the user's request from that combined result.</vision_image>`,
      }];
    }, {
      prepare: async () => {
        const config = resolvedConfig(source());
        if (!config.enabled || config.provider.length === 0 || config.model.length === 0) return false;
        if (disposeTool === undefined || disposeSkill === undefined) await refresh();
        return disposeTool !== undefined && disposeSkill !== undefined;
      },
    });
    void refresh();
    mediaCtx.effect(() => () => {
      if (mediaBinding !== binding) return;
      mediaBinding = undefined;
      mediaBlocks = undefined;
      generation += 1;
      disposeReferenceAdapter?.();
      disposeReferenceAdapter = undefined;
      clearRuntimeFeatures();
      activation = { status: 'error', message: '媒体块服务已停止' };
    }, 'dsh-vision: media blocks dependency');
  });

  void refresh();
  // Keep the last resolved user settings while the settings provider itself is
  // rebound. The canonical optional-settings helper falls back to entryConfig
  // during that gap; for this plugin an empty entry temporarily means
  // `enabled: false`, which used to unregister the visual route whenever a
  // model/provider switch rebuilt the settings service.
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

  ctx.inject(['webServer'], (webCtx) => {
    const routesRoute: WebRoute = {
      kind: 'exact',
      path: API_PATH,
      async handler(req, res) {
        if (req.method === 'POST') {
          const mediaType = requestImageMediaType(req);
          if (mediaType === undefined || !ctx.attachments.imageLimits.mediaTypes.includes(mediaType)) {
            req.resume();
            return sendJson(res, 415, { error: 'expected a supported PNG, JPEG, WebP, or GIF request body' });
          }
          try {
            const byteCap = Math.min(
              ctx.attachments.imageLimits.maxImageBytes,
              ctx.attachments.imageLimits.maxMessageImageBytes,
            );
            const data = await readRequestBytes(req, byteCap);
            const name = requestImageName(req);
            const ref = await ctx.attachments.saveImage({
              data,
              mediaType,
              ...(name === undefined ? {} : { name }),
            });
            return sendJson(res, 201, {
              imageRef: encodeImageRef(ref),
              attachment: { ...ref, attachmentId: String(ref.attachmentId) },
            });
          } catch (error) {
            if (error instanceof UploadTooLargeError) {
              return sendJson(res, 413, { error: 'image exceeds the configured attachment byte limit' });
            }
            return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        try {
          if (activation.status === 'checking' || activation.status === 'error') await refresh();
          const config = resolvedConfig(source());
          sendJson(res, 200, {
            providers: await listVisionProviders(ctx, config),
            activation,
            mediaBlocks: mediaBlocks?.status(),
          });
        } catch (error) {
          sendJson(res, 500, { error: String(error) });
        }
      },
    };
    const resourceRoute: WebRoute = {
      kind: 'exact',
      path: RESOURCE_API_PATH,
      async handler(req, res) {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        try {
          const token = new URL(req.url ?? RESOURCE_API_PATH, 'http://localhost').searchParams.get('ref');
          if (token === null) throw new Error('缺少资源引用');
          const stored = await ctx.attachments.readImage(decodeImageRef(token));
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
    webCtx.webServer.register(routesRoute);
    webCtx.webServer.register(resourceRoute);
  });

  ctx.effect(() => () => {
    generation += 1;
    mediaBinding = undefined;
    disposeReferenceAdapter?.();
    disposeReferenceAdapter = undefined;
    clearRuntimeFeatures();
  }, 'dsh-vision: dynamic tool and skill');
}
