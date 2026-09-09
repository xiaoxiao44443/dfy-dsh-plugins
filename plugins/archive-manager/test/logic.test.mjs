import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import {
  deleteAllArchivedSessions,
  deleteArchivedSession,
  isValidSessionId,
  listArchivedSessions,
  readArchivedIds,
} from '../lib/logic.js';

const ORIGINAL_HOME = process.env.DSH_HOME;

function makeRoot() {
  const root = join(tmpdir(), 'dsh-archive-test-' + Math.random().toString(36).slice(2));
  return root;
}

async function scaffold(root) {
  // 两个项目目录，各含一个会话；其中一个是归档的
  const projA = join(root, 'sessions', 'proj-a');
  const projB = join(root, 'sessions', 'proj-b');
  const archivedId = 'session-11111111-2222-3333-4444-555555555555';
  const liveId = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  await mkdir(join(projA, archivedId), { recursive: true });
  await mkdir(join(projB, liveId), { recursive: true });
  await writeFile(join(projA, archivedId, 'session.jsonl.zstd'), 'x');
  await writeFile(join(projB, liveId, 'session.jsonl.zstd'), 'x');
  await mkdir(join(root, 'storages'), { recursive: true });
  await writeFile(
    join(root, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: [archivedId] },
      tables: {
        workspaces: {
          'workspace-a': {
            path: '/tmp/项目甲',
            title: '项目甲',
            sessionIds: [archivedId],
          },
        },
      },
    }),
  );
  await writeFile(
    join(root, 'storages', 'session_projcache.json'),
    JSON.stringify({
      unit: { name: 'session_projcache', version: 3 },
      global: null,
      tables: {
        sessions: {
          [archivedId]: {
            identity: { createdAt: 1_700_000_000_000, cwd: '/tmp/项目甲' },
            rows: {
              title: { val: '格式化 MySQL 视图查询' },
              sessionListMetadata: { val: { lastPromptAt: 1_710_000_000_000 } },
            },
          },
        },
      },
    }),
  );
  return { archivedId, liveId };
}

test('isValidSessionId 只接受 session-<uuid>', () => {
  assert.ok(isValidSessionId('session-11111111-2222-3333-4444-555555555555'));
  assert.ok(!isValidSessionId('session-../../etc/passwd'));
  assert.ok(!isValidSessionId('session-123'));
  assert.ok(!isValidSessionId(''));
});

test('readArchivedIds 读取归档集合；损坏文件返回空', async (t) => {
  const root = makeRoot();
  process.env.DSH_HOME = root;
  t.after(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = ORIGINAL_HOME;
    return rm(root, { recursive: true, force: true });
  });
  await scaffold(root);
  const ids = await readArchivedIds();
  assert.deepEqual(ids, ['session-11111111-2222-3333-4444-555555555555']);
  await writeFile(join(root, 'storages', 'workspace.json'), 'not json{{{');
  assert.deepEqual(await readArchivedIds(), []);
});

test('listArchivedSessions 只返回归档且存在于磁盘的会话', async (t) => {
  const root = makeRoot();
  process.env.DSH_HOME = root;
  t.after(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = ORIGINAL_HOME;
    return rm(root, { recursive: true, force: true });
  });
  const { archivedId } = await scaffold(root);
  const list = await listArchivedSessions();
  assert.deepEqual(list.map((s) => s.id), [archivedId]);
  assert.deepEqual(list[0], {
    id: archivedId,
    title: '格式化 MySQL 视图查询',
    projectTitle: '项目甲',
    projectPath: '/tmp/项目甲',
    updatedAt: 1_710_000_000_000,
  });
});

test('listArchivedSessions 对 rc.1 未落盘的标题使用首条用户消息', async (t) => {
  const root = makeRoot();
  process.env.DSH_HOME = root;
  t.after(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = ORIGINAL_HOME;
    return rm(root, { recursive: true, force: true });
  });
  const { archivedId } = await scaffold(root);
  const projectionPath = join(root, 'storages', 'session_projcache.json');
  const projection = JSON.parse(await readFile(projectionPath, 'utf8'));
  projection.tables.sessions[archivedId].rows.title.val = null;
  projection.tables.sessions[archivedId].rows.sessionListMetadata.val.blank = true;
  await writeFile(projectionPath, JSON.stringify(projection));

  const logPath = join(root, 'sessions', 'proj-a', archivedId, 'session.jsonl.zstd');
  const header = JSON.stringify({ type: 'session', version: 1, id: archivedId }) + '\n';
  const events =
    [
      {
        seq: 0,
        type: 'user/message',
        data: {
          source: { kind: 'plugin', plugin: 'test-plugin' },
          content: [{ type: 'text', text: '插件注入文本不能成为标题' }],
        },
      },
      {
        seq: 1,
        type: 'user/message',
        data: {
          source: { kind: 'user' },
          content: [{ type: 'text', text: '  打印1\n' }],
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n';
  await writeFile(
    logPath,
    Buffer.concat([zstdCompressSync(Buffer.from(header)), zstdCompressSync(Buffer.from(events))]),
  );

  const [session] = await listArchivedSessions();
  assert.equal(session.title, '打印1');
  assert.notEqual(session.title, archivedId);
});

test('listArchivedSessions 在标题和日志都不可用时显示友好占位文本', async (t) => {
  const root = makeRoot();
  process.env.DSH_HOME = root;
  t.after(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = ORIGINAL_HOME;
    return rm(root, { recursive: true, force: true });
  });
  const { archivedId } = await scaffold(root);
  const projectionPath = join(root, 'storages', 'session_projcache.json');
  const projection = JSON.parse(await readFile(projectionPath, 'utf8'));
  projection.tables.sessions[archivedId].rows.title.val = null;
  await writeFile(projectionPath, JSON.stringify(projection));

  const [session] = await listArchivedSessions();
  assert.equal(session.title, '未命名对话');
});

for (const compressed of [false, true]) {
  test(`归档标题读取最新 V3 日志（压缩=${compressed}），忽略旧代及迁移临时文件`, async (t) => {
    const root = makeRoot();
    process.env.DSH_HOME = root;
    t.after(async () => {
      if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = ORIGINAL_HOME;
      await rm(root, { recursive: true, force: true });
    });
    const { archivedId } = await scaffold(root);
    await rm(join(root, 'storages', 'session_projcache.json'));
    const session = join(root, 'sessions', 'proj-a', archivedId);
    const title = (text) => JSON.stringify({ type: 'session/title', data: { title: text } }) + '\n';
    await writeFile(join(session, 'session.jsonl'), title('旧标题'));
    await writeFile(join(session, 'session.v2.jsonl'), title('V2 标题'));
    await writeFile(join(session, 'session.v9.jsonl.tmp'), title('未提交的标题'));
    await writeFile(join(session, 'session.v03.jsonl'), title('非标准文件名'));
    const filename = join(session, `session.v3.jsonl${compressed ? '.zstd' : ''}`);
    const log = JSON.stringify({ type: 'session', version: 3, id: archivedId }) + '\n' + title('V3 最新标题');
    await writeFile(filename, compressed ? zstdCompressSync(Buffer.from(log)) : log);
    assert.equal((await listArchivedSessions())[0].title, 'V3 最新标题');
    await writeFile(filename, 'broken');
    assert.equal((await listArchivedSessions())[0].title, '未命名对话');
  });
}

test('deleteArchivedSession：归档会话可删、活跃会话拒绝、非法 id 抛错', async (t) => {
  const root = makeRoot();
  process.env.DSH_HOME = root;
  t.after(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = ORIGINAL_HOME;
    return rm(root, { recursive: true, force: true });
  });
  const { archivedId, liveId } = await scaffold(root);

  // 未归档的会话：返回 0，目录保留
  assert.equal(await deleteArchivedSession(liveId), 0);

  // 归档会话：删除成功
  assert.equal(await deleteArchivedSession(archivedId), 1);
  assert.deepEqual(await listArchivedSessions(), []);
  // 删除后保留归档标记作为隐藏墓碑，避免当前 Host 暴露幽灵会话。
  assert.deepEqual(await readArchivedIds(), [archivedId]);

  // 再删一次：已不存在，返回 0
  assert.equal(await deleteArchivedSession(archivedId), 0);

  // 非法 id：抛错
  await assert.rejects(() => deleteArchivedSession('../../x'), /invalid session id/);
});

test('deleteAllArchivedSessions：删除全部归档会话并保留活跃会话', async (t) => {
  const root = makeRoot();
  process.env.DSH_HOME = root;
  t.after(() => {
    if (ORIGINAL_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = ORIGINAL_HOME;
    return rm(root, { recursive: true, force: true });
  });
  const { archivedId, liveId } = await scaffold(root);
  const secondArchivedId = 'session-66666666-7777-8888-9999-000000000000';
  await mkdir(join(root, 'sessions', 'proj-b', secondArchivedId), { recursive: true });
  await writeFile(join(root, 'sessions', 'proj-b', secondArchivedId, 'session.jsonl.zstd'), 'x');

  const workspacePath = join(root, 'storages', 'workspace.json');
  const workspace = JSON.parse(await readFile(workspacePath, 'utf8'));
  workspace.global.archivedSessionIds.push(secondArchivedId);
  workspace.tables.workspaces['workspace-b'] = {
    path: '/tmp/项目乙',
    title: '项目乙',
    sessionIds: [secondArchivedId, liveId],
  };
  await writeFile(workspacePath, JSON.stringify(workspace));

  assert.equal(await deleteAllArchivedSessions(), 2);
  assert.deepEqual(await listArchivedSessions(), []);
  assert.deepEqual(await readArchivedIds(), [archivedId, secondArchivedId]);
  assert.ok((await stat(join(root, 'sessions', 'proj-b', liveId))).isDirectory());
});
