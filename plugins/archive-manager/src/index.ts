/**
 * dsh-archive-manager Host 半区：通过 webServer 提供三个 HTTP 接口，
 * 供浏览器端设置页（./client）同源调用。
 *
 * GET  /api/dsh-archive-manager/list   -> { sessions: [{ id, title, projectTitle, projectPath, updatedAt }] }
 * POST /api/dsh-archive-manager/unarchive -> { ok }（body: { id }）
 * POST /api/dsh-archive-manager/delete -> { ok, deleted }（body: { id }）
 * POST /api/dsh-archive-manager/delete-all -> { ok, deleted }
 */
import type { Context } from '@deepseek-ai/cordis';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import {
  deleteAllArchivedSessions,
  deleteArchivedSession,
  isValidSessionId,
  listArchivedSessions,
} from './logic.js';

export const name = 'archive-manager';

/** 硬依赖：HTTP 服务和工作区注册表均就绪后插件才激活。 */
export const inject = ['webServer', 'workspaceRegistry'];

/** Use the public registry operation so persistence and live lists update together. */
async function unarchiveSession(ctx: Context, id: string): Promise<boolean> {
  if (!isValidSessionId(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  const registry = (ctx as Context & { workspaceRegistry: {
    archivedSessionIds: readonly string[];
    unarchiveSession(id: string): Promise<void>;
  } }).workspaceRegistry;
  if (!registry.archivedSessionIds.includes(id)) return false;
  await registry.unarchiveSession(id);
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > 1_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data.length === 0 ? {} : JSON.parse(data));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function apply(ctx: Context): void {
  const listRoute: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-archive-manager/list',
    async handler(req, res) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      try {
        sendJson(res, 200, { sessions: await listArchivedSessions() });
      } catch (error) {
        sendJson(res, 500, { error: String(error) });
      }
    },
  };

  const deleteRoute: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-archive-manager/delete',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      try {
        const body = (await readJsonBody(req)) as { id?: unknown };
        const id = typeof body?.id === 'string' ? body.id : '';
        const deleted = await deleteArchivedSession(id);
        if (deleted === 0) {
          sendJson(res, 404, { ok: false, error: '会话不存在或未归档' });
          return;
        }
        // 不要在删除后移除归档标记：当前 Host 仍可能在工作区与会话投影中
        // 持有该 id。此时取消归档会把一条磁盘记录已删除的“幽灵会话”重新
        // 暴露到对话列表，点击必然加载失败。保留归档标记可在本进程内持续
        // 隐藏它；归档管理按磁盘存在性过滤，所以删除后也不会再显示。
        sendJson(res, 200, { ok: true, deleted });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    },
  };

  const unarchiveRoute: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-archive-manager/unarchive',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      try {
        const body = (await readJsonBody(req)) as { id?: unknown };
        const id = typeof body?.id === 'string' ? body.id : '';
        const restored = await unarchiveSession(ctx, id);
        if (!restored) {
          sendJson(res, 404, { ok: false, error: '会话不存在或未归档' });
          return;
        }
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    },
  };

  const deleteAllRoute: WebRoute = {
    kind: 'exact',
    path: '/api/dsh-archive-manager/delete-all',
    async handler(req, res) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      try {
        const deleted = await deleteAllArchivedSessions();
        sendJson(res, 200, { ok: true, deleted });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    },
  };

  ctx.webServer.register(listRoute);
  ctx.webServer.register(unarchiveRoute);
  ctx.webServer.register(deleteRoute);
  ctx.webServer.register(deleteAllRoute);
}
