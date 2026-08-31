/** DSH Host half: authenticated loopback bridge for the companion Codex plugin. */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentSetup } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-agent-presets';
import { MessageId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings';
import type {} from '@deepseek-ai/dsh-skill';
import type {} from '@deepseek-ai/dsh-tools';
import { WorkspaceId } from '@deepseek-ai/dsh-workspace';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import z from '@deepseek-ai/schemastery';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  MAX_REQUEST_BYTES,
  bearerToken,
  codeModeToolArguments,
  isRecent,
  normalizeConfig,
  publicToolSchemas,
  selectAgent,
} from './logic.js';
import {
  RunTracker,
  createRunMessage,
  deterministicMessageId,
  runIdForMessageId,
  userMessageText,
  type RunMode,
} from './runs.js';

export const name = 'codex-bridge';
export const inject = ['agents', 'agentPresets', 'tools', 'skills', 'settings', 'webServer', 'workspaceRegistry'];

export interface Config {
  enabled?: boolean;
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
});

const SETTINGS_NS = 'dsh-codex-bridge' as SettingsNamespace;
const STATUS_PATH = '/api/dsh-codex-bridge/status';
const DISCOVERY_PATH = process.env.DSH_CODEX_BRIDGE_FILE
  ?? join(homedir(), '.saltfish', 'dfy-dsh', 'codex-bridge-endpoint.json');

interface RpcRequest {
  method?: unknown;
  params?: unknown;
}

interface BridgeState {
  server?: Server;
  origin?: string;
  token?: string;
  lastMcpSeenAt?: number;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function discoveryDocument(origin: string, token: string): string {
  return `${JSON.stringify({ version: 1, origin, token, pid: process.pid }, null, 2)}\n`;
}

async function writeDiscovery(origin: string, token: string): Promise<void> {
  await mkdir(dirname(DISCOVERY_PATH), { recursive: true });
  const temporary = `${DISCOVERY_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, discoveryDocument(origin, token), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, DISCOVERY_PATH);
}

async function removeOwnedDiscovery(token: string): Promise<void> {
  try {
    const current = JSON.parse(await readFile(DISCOVERY_PATH, 'utf8')) as { token?: unknown };
    if (current.token === token) await rm(DISCOVERY_PATH, { force: true });
  } catch {
    // A missing, malformed, or replaced discovery file is not ours to remove.
  }
}

function cwdOf(agent: Agent): string | undefined {
  return agent.session.header.cwd;
}

function agentView(agent: Agent, activeAt: number | undefined): Record<string, unknown> {
  return {
    id: String(agent.id),
    cwd: cwdOf(agent),
    status: agent.status,
    provider: agent.options.provider,
    model: agent.options.model,
    maxTokens: agent.options.maxTokens,
    agentPreset: agent.session.header.agentPreset,
    activeAt,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function optionalBoundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} 不能为空`);
  if (value.length > maximum) throw new Error(`${name} 不能超过 ${maximum} 个字符`);
  return value;
}

function runMode(value: unknown): RunMode {
  if (value === undefined || value === 'queue') return 'queue';
  if (value === 'steer') return 'steer';
  throw new Error('mode 必须是 queue 或 steer');
}

function submissionView(snapshot: ReturnType<RunTracker['snapshot']>, deduplicated: boolean): Record<string, unknown> {
  return {
    runId: snapshot.runId,
    sessionId: snapshot.sessionId,
    messageId: snapshot.messageId,
    mode: snapshot.mode,
    status: snapshot.status,
    cursor: snapshot.cursor,
    deduplicated,
  };
}

export function apply(ctx: Context, entryConfig: Config = {}): void {
  const activity = new Map<string, number>();
  const nestedResults = new Map<string, { result?: unknown }>();
  const bridge: BridgeState = {};
  const runs = new RunTracker(() => ctx.agents.list());
  let generation = 0;

  for (const agent of ctx.agents.list()) activity.set(String(agent.id), agent.session.header.createdAt);
  const touch = (agent: Agent): void => { activity.set(String(agent.id), Date.now()); };
  ctx.on('agent/created', ({ agent }) => touch(agent));
  ctx.on('agent/status', ({ agent }) => touch(agent));
  ctx.on('agent/inbox/inserted', ({ agent }) => touch(agent));
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    touch(agent);
    runs.onClaimed(agent, message, turn);
  });
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    touch(agent);
    runs.onDiscarded(agent, message);
  });
  ctx.on('agent/error', ({ agent, turn, step, error }) => runs.onAgentError(agent, turn, step, error));
  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.list().find((candidate) => candidate.session === session);
    if (agent !== undefined) runs.onSessionEvent(agent, event);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    activity.delete(String(agent.id));
    runs.onDisposed(agent);
  });
  ctx.on('tools/result', (exec, result) => {
    const pending = nestedResults.get(String(exec.callId));
    if (pending !== undefined) pending.result = result;
  });

  const requireAgent = (requestedId?: string): Agent => {
    const agents = ctx.agents.list();
    const agent = selectAgent(agents, activity, requestedId);
    if (agent === undefined) {
      if (requestedId !== undefined) throw new Error(`Harness 会话不存在或未运行：${requestedId}`);
      throw new Error('Harness 当前没有活动会话，请先新建或打开一个会话。');
    }
    touch(agent);
    return agent;
  };

  const dispatchRpc = async (request: RpcRequest): Promise<unknown> => {
    const method = typeof request.method === 'string' ? request.method : '';
    const params = request.params !== null && typeof request.params === 'object'
      ? request.params as Record<string, unknown>
      : {};
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    if (method === 'sessions.list') {
      return { sessions: ctx.agents.list().map((agent) => agentView(agent, activity.get(String(agent.id)))) };
    }
    if (method === 'sessions.create') {
      const templateId = optionalString(params.templateSessionId);
      const template = templateId === undefined
        ? selectAgent(ctx.agents.list(), activity)
        : ctx.agents.list().find((candidate) => String(candidate.id) === templateId);
      if (templateId !== undefined && template === undefined) {
        throw new Error(`用于继承配置的 Harness 会话不存在或未运行：${templateId}`);
      }

      const requestedWorkspaceId = optionalString(params.workspaceId);
      const requestedCwd = optionalString(params.cwd);
      let workspace = requestedWorkspaceId === undefined
        ? undefined
        : ctx.workspaceRegistry.get(WorkspaceId(requestedWorkspaceId));
      if (requestedWorkspaceId !== undefined && workspace === undefined) {
        throw new Error(`Harness 工作区不存在：${requestedWorkspaceId}`);
      }
      const requestedOrInheritedCwd = requestedCwd
        ?? workspace?.path
        ?? (template === undefined ? undefined : cwdOf(template));
      if (requestedOrInheritedCwd === undefined) {
        throw new Error('无法确定新会话的工作目录；请提供 cwd，或先打开一个 Harness 会话用于继承。');
      }
      if (workspace !== undefined && requestedCwd !== undefined) {
        const requestedWorkspace = await ctx.workspaceRegistry.resolveByPath(requestedCwd);
        if (requestedWorkspace?.id !== workspace.id) {
          throw new Error(`cwd 与工作区路径不一致：${workspace.path}`);
        }
      }
      workspace ??= await ctx.workspaceRegistry.resolveByPath(requestedOrInheritedCwd);
      workspace ??= await ctx.workspaceRegistry.create(requestedOrInheritedCwd);
      const cwd = workspace.path;

      const provider = optionalString(params.provider) ?? template?.options.provider;
      const model = optionalString(params.model) ?? template?.options.model;
      const maxTokens = optionalPositiveInteger(params.maxTokens, 'maxTokens') ?? template?.options.maxTokens;
      if (provider === undefined || model === undefined) {
        throw new Error('无法确定新会话的模型路由；请同时提供 provider 和 model，或先打开一个 Harness 会话用于继承。');
      }

      const requestedPreset = optionalString(params.agentPreset);
      let presetId: string;
      let setup: AgentSetup;
      if (requestedPreset !== undefined) {
        presetId = (await ctx.agentPresets.resolve(requestedPreset)).id;
        setup = async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, presetId); };
      } else if (template !== undefined) {
        presetId = ctx.agentPresets.composedPreset(template.ctx)
          ?? template.session.header.agentPreset
          ?? (await ctx.agentPresets.resolve()).id;
        setup = async (agentCtx) => {
          const inherited = ctx.agentPresets.composeFrom(agentCtx, template.ctx);
          if (inherited === undefined) await ctx.agentPresets.mount(agentCtx, presetId);
        };
      } else {
        presetId = (await ctx.agentPresets.resolve()).id;
        setup = async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, presetId); };
      }

      const newSessionId = SessionId(`session-${randomUUID()}`);
      const handle = await ctx.agents.create({
        sessionId: newSessionId,
        meta: { cwd, agentPreset: presetId },
        agentOptions: { provider, model, ...(maxTokens === undefined ? {} : { maxTokens }) },
        setup,
      });
      try {
        await workspace.attachSession(newSessionId);
      } catch (error) {
        await handle.dispose();
        throw error;
      }
      touch(handle.agent);
      return {
        session: agentView(handle.agent, activity.get(String(handle.agent.id))),
        workspace: { id: String(workspace.id), path: workspace.path, title: workspace.title },
        inheritedFrom: template === undefined ? undefined : String(template.id),
      };
    }
    if (method === 'runs.get') {
      const runId = requiredString(params.runId, 'runId', 500);
      const cursor = optionalString(params.cursor);
      const maxEvents = optionalBoundedInteger(params.maxEvents, 'maxEvents', 1, 200, 100);
      return runs.snapshot(runId, cursor, maxEvents);
    }
    if (method === 'runs.wait') {
      const runId = requiredString(params.runId, 'runId', 500);
      const cursor = optionalString(params.cursor);
      const timeoutMs = optionalBoundedInteger(params.timeoutMs, 'timeoutMs', 0, 30_000, 25_000);
      const maxEvents = optionalBoundedInteger(params.maxEvents, 'maxEvents', 1, 200, 100);
      return runs.wait(runId, cursor, timeoutMs, maxEvents);
    }
    if (method === 'runs.cancel') {
      const runId = requiredString(params.runId, 'runId', 500);
      const timeoutMs = optionalBoundedInteger(params.timeoutMs, 'timeoutMs', 0, 30_000, 10_000);
      const maxEvents = optionalBoundedInteger(params.maxEvents, 'maxEvents', 1, 200, 100);
      const before = runs.snapshot(runId, undefined, maxEvents);
      if (before.terminal) return { outcome: 'no_op', run: before };
      const resolved = runs.resolve(runId);
      if (resolved.agent === undefined) return { outcome: 'no_op', run: runs.snapshot(runId, undefined, maxEvents) };
      const removed = resolved.agent.inbox.remove(MessageId(resolved.record.messageId));
      if (removed) {
        runs.markQueuedCancelled(runId);
        return { outcome: 'cancelled', scope: 'queued_message', run: runs.snapshot(runId, undefined, maxEvents) };
      }
      const raced = runs.snapshot(runId, undefined, maxEvents);
      if (raced.terminal) return { outcome: 'no_op', run: raced };
      runs.markCancellationRequested(runId);
      resolved.agent.cancel({ kind: 'user' }, { keepInbox: true });
      const cursor = runs.snapshot(runId).cursor;
      const settled = await runs.wait(runId, cursor, timeoutMs, maxEvents);
      return {
        outcome: settled.terminal ? (settled.status === 'cancelled' ? 'cancelled' : 'no_op') : 'timeout',
        scope: 'active_turn',
        run: settled,
      };
    }
    const agent = requireAgent(sessionId);
    if (method === 'runs.send') {
      const text = requiredString(params.text, 'text', 100_000);
      const mode = runMode(params.mode);
      const clientRequestId = optionalString(params.clientRequestId);
      if (clientRequestId !== undefined && clientRequestId.length > 200) {
        throw new Error('clientRequestId 不能超过 200 个字符');
      }
      if (clientRequestId !== undefined) {
        const messageId = String(deterministicMessageId(String(agent.id), clientRequestId));
        const located = runs.findMessage(agent, messageId);
        if (located !== undefined) {
          if (userMessageText(located.message) !== text) {
            throw new Error('clientRequestId 已用于不同的消息内容');
          }
          if (located.turn === undefined && located.mode !== mode) {
            throw new Error('clientRequestId 已用于不同的发送模式');
          }
          const existing = runs.trackExisting(agent, located, mode, clientRequestId);
          if (existing.mode !== mode) throw new Error('clientRequestId 已用于不同的发送模式');
          return submissionView(existing, true);
        }
      }
      const message = createRunMessage(text, String(agent.id), clientRequestId);
      const startSeq = agent.session.seq;
      const registered = runs.register(agent, message, mode, startSeq, clientRequestId);
      try {
        if (mode === 'steer') agent.steer(message);
        else agent.followup(message);
      } catch (error) {
        runs.forget(registered.runId);
        throw error;
      }
      return submissionView(runs.snapshot(runIdForMessageId(String(message.id))), false);
    }
    if (method === 'messages.read') {
      const cursor = optionalBoundedInteger(params.cursor, 'cursor', 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = optionalBoundedInteger(params.limit, 'limit', 1, 200, 100);
      return runs.readMessages(agent, cursor, limit);
    }
    const options = { scope: agent, cwd: cwdOf(agent) };
    const schemas = ctx.tools.schemas(agent);
    if (method === 'tools.list') return { tools: publicToolSchemas(schemas) };
    if (method === 'tools.call') {
      if (typeof params.name !== 'string' || params.name.length === 0) throw new Error('tools.call 缺少工具名');
      const toolName = params.name;
      const target = schemas.find((schema) => schema.name === toolName && schema.name !== 'run_code');
      if (target === undefined) throw new Error(`Harness 工具不存在或当前会话不可用：${toolName}`);
      const callId = `codex-${randomUUID()}` as Parameters<typeof ctx.tools.execute>[0]['callId'];
      const runCode = schemas.find((schema) => schema.name === 'run_code');
      if (runCode === undefined) {
        return ctx.agents.withInitiator(agent, () => ctx.tools.execute({
          callId,
          name: toolName,
          arguments: params.arguments ?? {},
          agent,
          signal: AbortSignal.timeout(60 * 60_000),
        }));
      }
      const nestedCallId = `${String(callId)}:code:1`;
      const pending: { result?: unknown } = {};
      nestedResults.set(nestedCallId, pending);
      try {
        const outer = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
          callId,
          name: 'run_code',
          arguments: codeModeToolArguments(toolName, params.arguments ?? {}, runCode),
          agent,
          signal: AbortSignal.timeout(60 * 60_000),
        }));
        return pending.result ?? outer;
      } finally {
        nestedResults.delete(nestedCallId);
      }
    }
    if (method === 'skills.list') {
      const snapshot = await ctx.skills.snapshot(options);
      return { skills: snapshot.skills, complete: snapshot.complete };
    }
    if (method === 'skills.get') {
      if (typeof params.name !== 'string' || params.name.length === 0) throw new Error('skills.get 缺少 Skill 名称');
      const skill = await ctx.skills.get(params.name, options);
      if (skill === undefined) throw new Error(`Harness Skill 不存在：${params.name}`);
      return skill;
    }
    throw new Error(`不支持的桥接方法：${method}`);
  };

  const stopBridge = async (): Promise<void> => {
    generation += 1;
    const server = bridge.server;
    const token = bridge.token;
    bridge.server = undefined;
    bridge.origin = undefined;
    bridge.token = undefined;
    bridge.lastMcpSeenAt = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (token !== undefined) await removeOwnedDiscovery(token);
  };

  const startBridge = async (): Promise<void> => {
    if (bridge.server !== undefined) return;
    const currentGeneration = ++generation;
    const token = randomBytes(32).toString('base64url');
    const server = createServer(async (req, res) => {
      try {
        if (bearerToken(req.headers.authorization) !== token) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        bridge.lastMcpSeenAt = Date.now();
        if (req.method === 'GET' && req.url === '/v1/status') {
          sendJson(res, 200, { ok: true, sessions: ctx.agents.list().length });
          return;
        }
        if (req.method !== 'POST' || req.url !== '/v1/rpc') {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        const request = await readJson(req) as RpcRequest;
        sendJson(res, 200, { result: await dispatchRpc(request) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, message === 'request body too large' ? 413 : 400, { error: message });
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (currentGeneration !== generation) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return;
    }
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('无法读取 Codex 桥接监听地址');
    const origin = `http://127.0.0.1:${address.port}`;
    await writeDiscovery(origin, token);
    bridge.server = server;
    bridge.origin = origin;
    bridge.token = token;
  };

  let latest = normalizeConfig(entryConfig);
  const scope = ctx.settings.register(SETTINGS_NS, Config, { base: entryConfig });
  latest = normalizeConfig(scope.get());
  const sync = (): void => {
    if (latest.enabled) void startBridge().catch((error) => {
      bridge.origin = undefined;
      bridge.token = undefined;
      console.error('[dsh-codex-bridge] start failed', error);
    });
    else void stopBridge();
  };
  scope.watch((next) => { latest = normalizeConfig(next); sync(); });
  sync();

  const statusRoute: WebRoute = {
    kind: 'exact',
    path: STATUS_PATH,
    async handler(req, res) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      sendJson(res, 200, {
        enabled: latest.enabled,
        running: bridge.server !== undefined,
        origin: bridge.origin,
        sessions: ctx.agents.list().length,
        mcpConnected: isRecent(bridge.lastMcpSeenAt),
        lastMcpSeenAt: bridge.lastMcpSeenAt,
      });
    },
  };

  ctx.webServer.register(statusRoute);
  ctx.effect(() => () => {
    runs.dispose();
    void stopBridge();
  }, 'dsh-codex-bridge: loopback server');
}
