import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { encodeMediaImageRef } from './reference.js';

interface NativeRequest {
  requestId: string;
  sessionId: string;
  mode: 'queue' | 'steer';
  content: readonly ({ type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string; name?: string } | { type: 'file'; receiptId: string })[];
  clientTimeZone?: string;
}
interface ReceiptBinding { commit(): void; [Symbol.dispose](): void }
export interface NativeController {
  readonly ctx?: { readonly invocation?: { readonly peer?: { readonly principal?: { kind: string; [key: string]: unknown } } } };
  prompt(request: NativeRequest, signal: AbortSignal): Promise<{ accepted: true }>;
  resolveAgent(sessionId: string): Promise<{ agent: Agent } | { error: unknown }>;
}
export interface NativePromptDependencies {
  prepare(): Promise<boolean>;
  admit(content: readonly unknown[]): Promise<readonly unknown[]>;
  isLive(agent: Agent): boolean;
  files: {
    resolve(agent: Agent, receiptId: string): unknown;
    bindPrompt(agent: Agent, receipts: readonly string[], requestId: string): ReceiptBinding;
  };
}

function imageUnsupported(error: unknown): boolean {
  const failure = error as { code?: unknown; details?: { reason?: unknown } } | null;
  return failure?.code === 'session/attachment-invalid' && failure.details?.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES';
}
function attachmentError(message: string, reason: string): Error {
  // RemoteError's documented cross-bundle wire contract is structural.
  return Object.assign(new Error(message), { isDSHRemoteError: true, code: 'session/attachment-invalid', details: { reason } });
}

interface Installation {
  owner: object;
  tails: Map<string, Promise<unknown>>;
  handler(this: NativeController, request: NativeRequest, signal: AbortSignal): Promise<{ accepted: true }>;
  original: NativeController['prompt'];
  restore(): void;
}
const INSTALLATION = Symbol.for('@dfy-plugins/dsh-media-blocks/native-prompt');

/** Extend only the official image-capability rejection; other admission rules stay authoritative. */
export function installNativePromptBridge(controller: NativeController, deps: NativePromptDependencies): () => void {
  const target = controller as NativeController & { [INSTALLATION]?: Installation };
  const owner = {};
  let installation = target[INSTALLATION];
  if (!installation) {
    const descriptor = Object.getOwnPropertyDescriptor(controller, 'prompt');
    const original = controller.prompt;
    const state: Installation = {
      owner, tails: new Map(), original,
      handler(request, signal) { return original.call(this, request, signal); },
      restore() {
        if (Object.getOwnPropertyDescriptor(controller, 'prompt')?.value !== wrapped) return;
        if (descriptor) Object.defineProperty(controller, 'prompt', descriptor);
        else Reflect.deleteProperty(controller, 'prompt');
        Reflect.deleteProperty(target, INSTALLATION);
      },
    };
    const wrapped: NativeController['prompt'] = function (this: NativeController, request, signal) {
      // Gateway receivers carry per-call context; retain it across the FIFO wait.
      const receiver = this;
      const before = state.tails.get(request.sessionId) ?? Promise.resolve();
      const result = before.catch(() => {}).then(() => { signal.throwIfAborted(); return state.handler.call(receiver, request, signal); });
      state.tails.set(request.sessionId, result);
      void result.finally(() => { if (state.tails.get(request.sessionId) === result) state.tails.delete(request.sessionId); }).catch(() => {});
      return result;
    };
    Object.defineProperty(controller, 'prompt', { configurable: true, writable: true, value: wrapped });
    Object.defineProperty(target, INSTALLATION, { configurable: true, value: state });
    installation = state;
  }
  const state = installation;
  state.owner = owner;
  state.handler = async function (request, signal) {
    const receiver = this;
    const principal = receiver.ctx && 'invocation' in receiver.ctx
      ? receiver.ctx.invocation?.peer?.principal : undefined;
    let originalError: unknown;
    try { return await state.original.call(receiver, request, signal); }
    catch (error) {
      if (!imageUnsupported(error) || !request.content.some((part) => part.type === 'image')) throw error;
      originalError = error;
    }
    signal.throwIfAborted();
    if (!await deps.prepare()) throw originalError;
    const resolved = await receiver.resolveAgent(request.sessionId);
    if ('error' in resolved) throw resolved.error;
    const { agent } = resolved;
    const receipts = new Set<string>();
    const parts = request.content.map((part) => {
      if (part.type !== 'file') return part;
      const attachment = deps.files.resolve(agent, part.receiptId);
      if (attachment === undefined) throw attachmentError('文件尚未上传到当前会话。', 'FILE_NOT_STAGED');
      receipts.add(part.receiptId);
      return { type: 'file', attachment };
    });
    let admitted: readonly unknown[];
    try { admitted = await deps.admit(parts); }
    catch (error) {
      throw attachmentError(error instanceof Error ? error.message : String(error), (error as { code?: string })?.code ?? 'INVALID_ATTACHMENT');
    }
    const content = admitted.map((part) => {
      const block = part as { type: string; attachment?: ImageAttachmentRef };
      if (block.type !== 'image' || block.attachment === undefined) return part;
      const attachment = block.attachment;
      return { type: 'plugin:dfy-media', version: 1, resource: { kind: 'image', attachment, ref: encodeMediaImageRef(attachment) } };
    }) as ContentBlock[];
    signal.throwIfAborted();
    if (state.owner !== owner || !deps.isLive(agent)) throw attachmentError('会话或媒体插件已重新加载，请重试上传。', 'SESSION_CHANGED');
    const message = createUserMessage({ content, source: {
      kind: 'user', rpcId: request.requestId,
      ...(principal === undefined || principal.kind === 'owner' ? {} : { principal }),
      ...(request.clientTimeZone === undefined ? {} : { clientTimeZone: request.clientTimeZone }),
    } });
    const binding = deps.files.bindPrompt(agent, [...receipts], request.requestId);
    try {
      if (request.mode === 'steer') agent.steer(message);
      else agent.followup(message);
      binding.commit();
      return { accepted: true };
    } finally { binding[Symbol.dispose](); }
  };
  return () => {
    if (state.owner !== owner) return;
    state.owner = {};
    state.handler = function (request, signal) { return state.original.call(this, request, signal); };
    state.restore();
  };
}
