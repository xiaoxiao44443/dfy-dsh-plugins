/**
 * 归档会话的核心逻辑（纯 Node 模块，便于单测）。
 *
 * 事实来源约定：
 * - 归档集合：$DSH_HOME/storages/workspace.json 的 global.archivedSessionIds
 * - 会话数据：$DSH_HOME/sessions/<workspace>/session-<uuid>/（持久化层按目录扫描）
 * - 删除 = 删除会话目录，并保留归档 id 作为当前 Host 生命周期内的隐藏墓碑；
 *   否则内存中的旧会话投影会短暂变成无法打开的“幽灵会话”。
 */
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** dsh 数据根目录（与 dsh CLI 的 DSH_HOME 约定一致）。 */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** 会话持久化根目录。 */
export function sessionsRoot(): string {
  return join(dshHome(), 'sessions');
}

/** workspace 注册表文件路径（归档集合的权威来源）。 */
export function workspaceJsonPath(): string {
  return join(dshHome(), 'storages', 'workspace.json');
}

/** 会话列表投影缓存（标题、创建时间和最后一次提问时间）。 */
export function sessionProjectionJsonPath(): string {
  return join(dshHome(), 'storages', 'session_projcache.json');
}

const SESSION_ID_RE =
  /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNTITLED_SESSION_TITLE = '未命名对话';
const FALLBACK_TITLE_MAX_WORDS = 5;
const FALLBACK_TITLE_MAX_BYTES = 40;
const ZSTD_MAGIC = 0xfd2fb528;

const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu;
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
const ESC_SEQUENCE = /\u001B[@-_]/gu;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

/** 会话 id 是否形如 session-<uuid>。 */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/** 读取归档会话 id 集合；workspace.json 缺失或损坏时返回空集合。 */
export async function readArchivedIds(): Promise<string[]> {
  try {
    const raw = await readFile(workspaceJsonPath(), 'utf8');
    const data: unknown = JSON.parse(raw);
    const ids = (data as { global?: { archivedSessionIds?: unknown } })?.global?.archivedSessionIds;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface ArchivedSession {
  id: string;
  title: string;
  projectTitle: string;
  projectPath: string | null;
  updatedAt: number | null;
}

interface WorkspaceRecord {
  path?: unknown;
  title?: unknown;
  sessionIds?: unknown;
}

interface WorkspaceStore {
  tables?: {
    workspaces?: Record<string, WorkspaceRecord>;
  };
}

interface SessionProjection {
  identity?: {
    createdAt?: unknown;
    cwd?: unknown;
  };
  rows?: {
    title?: { val?: unknown };
    sessionListMetadata?: { val?: { lastPromptAt?: unknown } };
  };
}

interface SessionProjectionStore {
  tables?: {
    sessions?: Record<string, SessionProjection>;
  };
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncateUtf8(input: string, maxBytes: number): string {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let output = '';
  let used = 0;
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

/** 与 DSH session-title 的首条用户消息兜底规则保持一致。 */
function fallbackSessionTitle(input: string): string | undefined {
  const clean = input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const title = truncateUtf8(
    clean.split(' ').filter(Boolean).slice(0, FALLBACK_TITLE_MAX_WORDS).join(' '),
    FALLBACK_TITLE_MAX_BYTES,
  ).trimEnd();
  return title.length > 0 ? title : undefined;
}

interface ZstdFrameRange {
  start: number;
  end: number;
}

/** 扫描 DSH 追加写入的独立 Zstandard 帧；不把压缩块中的偶然 magic 当作边界。 */
function scanZstdFrames(buffer: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid Zstandard frame at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) break;

    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) throw new Error('invalid Zstandard frame descriptor');
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;

    let complete = false;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('invalid Zstandard block type');
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (lastBlock) {
        complete = true;
        break;
      }
    }
    if (!complete) break;
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

interface SessionLogEvent {
  type?: unknown;
  data?: {
    title?: unknown;
    source?: { kind?: unknown };
    content?: unknown;
  };
}

function titleStateFromEvent(
  event: SessionLogEvent,
  state: { durableTitle?: string; firstUserTitle?: string },
): void {
  if (event.type === 'session/title') {
    state.durableTitle = nonEmptyString(event.data?.title);
    return;
  }
  if (state.firstUserTitle !== undefined || event.type !== 'user/message') return;
  if (event.data?.source?.kind !== 'user' || !Array.isArray(event.data.content)) return;
  const text = event.data.content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
  state.firstUserTitle = fallbackSessionTitle(text);
}

function titleFromJsonLines(lines: Iterable<string>): string | undefined {
  const state: { durableTitle?: string; firstUserTitle?: string } = {};
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      titleStateFromEvent(JSON.parse(line) as SessionLogEvent, state);
    } catch {
      // 标题兜底不应因单条损坏记录拖垮整个归档列表。
    }
  }
  return state.durableTitle ?? state.firstUserTitle;
}

async function titleFromSessionLog(sessionDirectory: string): Promise<string | undefined> {
  let filenames: string[];
  try {
    const entries = await readdir(sessionDirectory, { withFileTypes: true });
    const logs = entries.flatMap((entry) => {
      const match = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/.exec(entry.name);
      return entry.isFile() && match !== null ? [{ name: entry.name, version: Number(match[1] ?? 0) }] : [];
    });
    const version = Math.max(...logs.map((log) => log.version));
    // Only the highest committed generation is authoritative. A failed or
    // title-less new log must never reveal a stale historical title.
    filenames = logs.filter((log) => log.version === version)
      .sort((a, b) => Number(b.name.endsWith('.zstd')) - Number(a.name.endsWith('.zstd')))
      .map((log) => log.name);
  } catch {
    return undefined;
  }
  for (const filename of filenames) {
    try {
      if (!filename.endsWith('.zstd')) {
        return titleFromJsonLines((await readFile(join(sessionDirectory, filename), 'utf8')).split('\n'));
      }
      const buffer = await readFile(join(sessionDirectory, filename));
      const lines: string[] = [];
      for (const frame of scanZstdFrames(buffer)) {
        lines.push(
          ...zstdDecompressSync(buffer.subarray(frame.start, frame.end))
            .toString('utf8')
            .split('\n'),
        );
      }
      return titleFromJsonLines(lines);
    } catch {
      // 兼容关闭压缩；同一代日志缺失或损坏时继续尝试另一种编码。
    }
  }
  return undefined;
}

/**
 * 列出所有仍存在于磁盘的归档会话（按最后修改时间倒序）。
 * 只返回「归档集合 ∩ 磁盘目录」中的会话。
 */
export async function listArchivedSessions(): Promise<ArchivedSession[]> {
  const archived = new Set(await readArchivedIds());
  const out: ArchivedSession[] = [];
  const workspaceStore = await readJson<WorkspaceStore>(workspaceJsonPath());
  const projectionStore = await readJson<SessionProjectionStore>(sessionProjectionJsonPath());
  const workspaceBySession = new Map<string, { title: string; path: string | null }>();

  for (const workspace of Object.values(workspaceStore?.tables?.workspaces ?? {})) {
    if (!Array.isArray(workspace.sessionIds)) continue;
    const path = nonEmptyString(workspace.path) ?? null;
    const title = nonEmptyString(workspace.title) ?? (path === null ? '无项目' : basename(path));
    for (const sessionId of workspace.sessionIds) {
      if (typeof sessionId === 'string' && !workspaceBySession.has(sessionId)) {
        workspaceBySession.set(sessionId, { title, path });
      }
    }
  }

  let projects: string[] = [];
  try {
    projects = await readdir(sessionsRoot());
  } catch {
    return out;
  }
  for (const project of projects) {
    let entries: string[] = [];
    try {
      entries = await readdir(join(sessionsRoot(), project));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!archived.has(entry) || !isValidSessionId(entry)) continue;
      try {
        const sessionDirectory = join(sessionsRoot(), project, entry);
        const st = await stat(sessionDirectory);
        const projection = projectionStore?.tables?.sessions?.[entry];
        const cachedCwd = nonEmptyString(projection?.identity?.cwd) ?? null;
        const workspace = workspaceBySession.get(entry);
        const projectPath = workspace?.path ?? cachedCwd;
        const projectTitle = workspace?.title ?? (projectPath === null ? '无项目' : basename(projectPath));
        const title =
          nonEmptyString(projection?.rows?.title?.val) ??
          (await titleFromSessionLog(sessionDirectory)) ??
          UNTITLED_SESSION_TITLE;
        const updatedAt =
          finiteNumber(projection?.rows?.sessionListMetadata?.val?.lastPromptAt) ??
          finiteNumber(st.mtimeMs) ??
          finiteNumber(projection?.identity?.createdAt) ??
          null;
        out.push({ id: entry, title, projectTitle, projectPath, updatedAt });
      } catch {
        // 目录被并发删除等情形：跳过
      }
    }
  }
  out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return out;
}

/**
 * 永久删除一个归档会话的磁盘目录。
 * 安全约束：id 必须形如 session-<uuid> 且必须在归档集合中，
 * 双重校验防止路径注入与误删活跃会话。
 * @returns 删除的目录数量（0 = 未归档或不存在）。
 */
async function deleteArchivedSessionDirectories(ids: ReadonlySet<string>): Promise<number> {
  if (ids.size === 0) return 0;
  let projects: string[] = [];
  try {
    projects = await readdir(sessionsRoot());
  } catch {
    return 0;
  }
  let deleted = 0;
  for (const project of projects) {
    let entries: string[] = [];
    try {
      entries = await readdir(join(sessionsRoot(), project));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!ids.has(entry) || !isValidSessionId(entry)) continue;
      try {
        await rm(join(sessionsRoot(), project, entry), { recursive: true });
        deleted += 1;
      } catch {
        // 不存在或删除失败：继续其他会话目录
      }
    }
  }
  return deleted;
}

export async function deleteArchivedSession(id: string): Promise<number> {
  if (!isValidSessionId(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  const archived = new Set(await readArchivedIds());
  if (!archived.has(id)) return 0;
  return deleteArchivedSessionDirectories(new Set([id]));
}

/** 永久删除当前仍存在于磁盘的全部归档会话。 */
export async function deleteAllArchivedSessions(): Promise<number> {
  const archived = new Set((await readArchivedIds()).filter(isValidSessionId));
  return deleteArchivedSessionDirectories(archived);
}
