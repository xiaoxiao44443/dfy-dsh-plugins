/** Session-owned, sandboxed HTML visualizations for DeepSeek Harness. */
import { persistedSessionArtifactDirectory, sessionArtifactDirectory } from '@dfy-plugins/resource-core/session-storage';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-fs';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-session-persistence';
import type {} from '@deepseek-ai/dsh-skill';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { GenericCallView, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  injectVisualizationBridge,
  MAX_ASSET_BYTES,
  MAX_ASSETS,
  MAX_HTML_BYTES,
  MAX_TOTAL_ASSET_BYTES,
  normalizeTitle,
  validateAssetName,
  visualizationUrl,
  type VisualizationMeta,
} from './logic.js';

export const name = 'visualize';
export const inject = ['tools', 'fs', 'skills', 'sessionPersistence'];

export const VISUALIZATION_API_PATH = '/api/dsh-visualize/artifacts';
const TOOL_NAME = 'dfy_visualize_render';
const SKILL_NAME = 'dfy-visualize';
const ARTIFACT_SUBDIR = join('artifacts', 'visualizations');

const SKILL_CONTENT = `# DFY Visualize

Use this Skill when an explanation benefits from an interactive chart, diagram, comparison, simulator, or UI mockup rendered directly in the conversation.

## Host surface contract

The artifact is embedded directly beneath an assistant response; it is not a standalone web page. Unless the user explicitly requests a card, poster, dashboard shell, or full-canvas background:

- Keep \`html\` and \`body\` marginless and transparent. Do not use \`min-height: 100vh\` or page-level flex/grid centering merely to imitate a standalone page.
- Keep the Host canvas itself transparent; do not paint a page-sized background behind the artifact.
- Keep the top-level visualization surface transparent and unframed, and use the available conversation width. Organize structural groups and repeated content with layout, spacing, dividers, or visual marks instead of container chrome.
- Use a card-like surface only for a necessary bounded interactive field or concise summary. Keep charts, maps, diagrams, tables, control groups, and the whole visualization unframed, and never nest cards.
- Do not render a heading that repeats the Tool \`title\`, and do not add a viewer titlebar, status, reload, fullscreen, or theme toolbar. Start with the actual visualization or controls.
- Backgrounds, borders, radii, and shadows remain appropriate for meaningful internal elements such as plot areas, nodes, swatches, inputs, and data cells.
- Support the Host theme through \`:root[data-theme='dark']\` as well as the initial color scheme when theme-specific colors are needed.

## Required workflow

1. Create a complete responsive HTML document in the current workspace. Keep CSS and JavaScript inline whenever practical.
2. Do not use CDNs, remote scripts, remote fonts, network requests, forms, popups, or top-window navigation. The viewer intentionally blocks them.
3. Make the page usable at narrow and wide widths. Avoid a fixed canvas width and avoid document-level scrolling when the content can size naturally.
4. Keep primary content that expands or collapses through interaction in normal document flow so the Host can measure its changing height. Do not give the document a fixed height, position primary layout content absolutely or fixed, or clip it with \`overflow: hidden\`; out-of-flow positioning remains appropriate for genuine overlays such as menus, tooltips, and dialogs.
5. If the HTML needs local images, fonts, CSS, or JavaScript, reference each as \`assets/<basename>\` and pass every source file in \`asset_paths\`. Asset basenames must be unique.
6. Before publishing, inspect the HTML against the Host surface contract. Remove page-sized decoration, unnecessary wrapper surfaces, nested cards, and repeated titles added by habit.
7. Call \`${TOOL_NAME}\` exactly once with the HTML \`file_path\`, a short \`title\`, and any \`asset_paths\`.
8. After success, give only a concise explanation or usage hint. The Harness UI displays the visualization after the final response; do not repeat it, embed it, call the render tool again, or paste the HTML into the conversation.

The published artifact is immutable and belongs to the current session. Archiving keeps it; permanently deleting the session removes it together with the transcript.`;

interface WorkspaceFile {
  data: Uint8Array;
  displayPath: string;
  version: unknown;
}

interface StoredAsset {
  name: string;
  bytes: number;
  data: Uint8Array;
}

interface VisualizationValue extends VisualizationMeta {
  url: string;
  htmlBytes: number;
  assets: Array<{ name: string; bytes: number }>;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

async function readWorkspaceFile(
  ctx: Context,
  exec: ToolRunContext,
  requestedPath: string,
  limit: number,
): Promise<WorkspaceFile> {
  const cwd = exec.agent?.session.header.cwd;
  const target = await ctx.fs.resolve(requestedPath, {
    ...(cwd === undefined ? {} : { cwd }),
    signal: exec.signal,
  });
  const info = await ctx.fs.stat(target, exec.signal);
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec);
    throw new Error(`visualization source not found: ${target.displayPath}`);
  }
  if (info.type !== 'file') throw new Error(`visualization source is not a regular file: ${target.displayPath}`);
  if (info.size !== undefined && info.size > limit) {
    throw new Error(`visualization source exceeds the ${String(limit)} byte limit: ${target.displayPath}`);
  }
  const data = await ctx.fs.readBytes(target, exec.signal, limit);
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
  return { data, displayPath: target.displayPath, version: info.version };
}

function decodeHtml(file: WorkspaceFile): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file.data);
  } catch {
    throw new Error(`visualization HTML is not valid UTF-8: ${file.displayPath}`);
  }
}

function sessionDirectory(ctx: Context, exec: ToolRunContext): { sessionId: string; directory: string } {
  const agent = exec.agent;
  if (agent === undefined) throw new Error('visualization rendering requires an active DSH session');
  const directory = sessionArtifactDirectory(ctx.sessionPersistence, agent.session.header);
  if (directory === undefined) {
    throw new Error('the configured session persistence backend does not expose a session-owned artifact directory');
  }
  return { sessionId: String(agent.id), directory };
}

async function publishVisualization(
  ctx: Context,
  exec: ToolRunContext,
  requestedHtmlPath: string,
  requestedTitle: string | undefined,
  requestedAssets: readonly string[],
  rememberedSessionDirs: Map<string, string>,
): Promise<VisualizationValue> {
  exec.signal.throwIfAborted();
  if (!/\.html?$/i.test(requestedHtmlPath)) throw new Error('visualization file_path must end in .html or .htm');
  if (requestedAssets.length > MAX_ASSETS) throw new Error(`a visualization may contain at most ${String(MAX_ASSETS)} assets`);

  const htmlFile = await readWorkspaceFile(ctx, exec, requestedHtmlPath, MAX_HTML_BYTES);
  const html = decodeHtml(htmlFile);
  const fallbackTitle = basename(htmlFile.displayPath, extname(htmlFile.displayPath));
  const title = normalizeTitle(requestedTitle, fallbackTitle);
  const assets: StoredAsset[] = [];
  const names = new Set<string>();
  let totalAssetBytes = 0;
  for (const requestedPath of requestedAssets) {
    exec.signal.throwIfAborted();
    const file = await readWorkspaceFile(ctx, exec, requestedPath, MAX_ASSET_BYTES);
    const assetName = validateAssetName(basename(file.displayPath));
    const comparisonKey = process.platform === 'win32' ? assetName.toLocaleLowerCase('en-US') : assetName;
    if (names.has(comparisonKey)) throw new Error(`visualization asset basenames must be unique: ${assetName}`);
    names.add(comparisonKey);
    totalAssetBytes += file.data.byteLength;
    if (totalAssetBytes > MAX_TOTAL_ASSET_BYTES) {
      throw new Error(`visualization assets exceed the ${String(MAX_TOTAL_ASSET_BYTES)} byte total limit`);
    }
    assets.push({ name: assetName, bytes: file.data.byteLength, data: file.data });
  }

  const session = sessionDirectory(ctx, exec);
  const artifactId = randomUUID();
  const artifactsRoot = resolve(session.directory, ARTIFACT_SUBDIR);
  if (!inside(session.directory, artifactsRoot)) throw new Error('invalid session artifact root');
  const finalDirectory = resolve(artifactsRoot, artifactId);
  const temporaryDirectory = resolve(artifactsRoot, `.tmp-${artifactId}`);
  if (!inside(artifactsRoot, finalDirectory) || !inside(artifactsRoot, temporaryDirectory)) {
    throw new Error('invalid visualization artifact path');
  }

  const meta: VisualizationMeta = {
    kind: 'dsh-visualization',
    version: 1,
    sessionId: session.sessionId,
    artifactId,
    title,
    assetCount: assets.length,
  };
  const renderedHtml = injectVisualizationBridge(html, artifactId);
  try {
    await mkdir(join(temporaryDirectory, 'assets'), { recursive: true });
    exec.signal.throwIfAborted();
    await writeFile(join(temporaryDirectory, 'index.html'), renderedHtml, { encoding: 'utf8', flag: 'wx' });
    for (const asset of assets) {
      exec.signal.throwIfAborted();
      await writeFile(join(temporaryDirectory, 'assets', asset.name), asset.data, { flag: 'wx' });
    }
    await writeFile(join(temporaryDirectory, 'manifest.json'), `${JSON.stringify({
      ...meta,
      createdAt: Date.now(),
      htmlBytes: htmlFile.data.byteLength,
      assets: assets.map(({ name, bytes }) => ({ name, bytes })),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    exec.signal.throwIfAborted();
    await rename(temporaryDirectory, finalDirectory);
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  rememberedSessionDirs.set(session.sessionId, session.directory);
  return {
    ...meta,
    url: visualizationUrl(meta),
    htmlBytes: htmlFile.data.byteLength,
    assets: assets.map(({ name, bytes }) => ({ name, bytes })),
  };
}

function renderResult(value: VisualizationValue): string {
  const assetLabel = value.assetCount === 0 ? '' : `，包含 ${String(value.assetCount)} 个素材`;
  return `已创建可视化“${value.title}”${assetLabel}。可视化已显示在对话中。`;
}

function createVisualizationTool(ctx: Context, rememberedSessionDirs: Map<string, string>) {
  return defineTool({
    name: TOOL_NAME,
    description: `Publish a workspace HTML document as a sandboxed interactive visualization in the current conversation. Read the ${SKILL_NAME} Skill before every call. Keep the top-level surface transparent and unframed, omit repeated title/header or viewer chrome, and reserve card surfaces for necessary bounded content.`,
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Workspace path to a complete UTF-8 .html or .htm document.',
      },
      title: {
        type: 'string',
        description: 'Short user-facing title for the visualization.',
      },
      asset_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional workspace files copied beside the HTML. Reference them from HTML as assets/<basename>.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          version: { type: 'integer', required: true },
          sessionId: { type: 'string', required: true },
          artifactId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          assetCount: { type: 'integer', required: true },
          url: { type: 'string', required: true },
          htmlBytes: { type: 'integer', required: true },
          assets: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value as unknown as VisualizationValue) }],
      presentationMeta: (_args, value) => {
        const artifact = value as unknown as VisualizationValue;
        return {
          kind: artifact.kind,
          version: artifact.version,
          sessionId: artifact.sessionId,
          artifactId: artifact.artifactId,
          title: artifact.title,
          assetCount: artifact.assetCount,
        };
      },
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => publishVisualization(
      ctx,
      exec,
      args.file_path,
      args.title,
      args.asset_paths ?? [],
      rememberedSessionDirs,
    ),
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: 'DFY VISUALIZE',
        kind: 'read',
        locations: [{ path: args.file_path }],
      };
    },
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

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html': case '.htm': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.avif': return 'image/avif';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.mp3': return 'audio/mpeg';
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    default: return 'application/octet-stream';
  }
}

async function persistedSessionDirectory(
  ctx: Context,
  sessionId: string,
  rememberedSessionDirs: Map<string, string>,
  signal: AbortSignal,
): Promise<string | undefined> {
  const remembered = rememberedSessionDirs.get(sessionId);
  if (remembered !== undefined) return remembered;
  const directory = await persistedSessionArtifactDirectory(ctx.sessionPersistence, sessionId, signal);
  if (directory === undefined) return undefined;
  rememberedSessionDirs.set(sessionId, directory);
  return directory;
}

async function resolveArtifactFile(
  ctx: Context,
  rememberedSessionDirs: Map<string, string>,
  sessionId: string,
  artifactId: string,
  relativeFile: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (sessionId.length === 0 || sessionId.length > 200) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(artifactId)) return undefined;
  const sessionDir = await persistedSessionDirectory(ctx, sessionId, rememberedSessionDirs, signal);
  if (sessionDir === undefined) return undefined;
  const artifactRoot = resolve(sessionDir, ARTIFACT_SUBDIR, artifactId);
  const candidate = resolve(artifactRoot, relativeFile);
  if (!inside(artifactRoot, candidate)) return undefined;
  try {
    const [realRoot, realCandidate] = await Promise.all([realpath(artifactRoot), realpath(candidate)]);
    if (!inside(realRoot, realCandidate)) return undefined;
    return realCandidate;
  } catch {
    return undefined;
  }
}

function decodeRoute(req: Parameters<WebRoute['handler']>[0]): {
  sessionId: string;
  artifactId: string;
  relativeFile: string;
} | undefined {
  const pathname = new URL(req.url ?? VISUALIZATION_API_PATH, 'http://localhost').pathname;
  const suffix = pathname.slice(VISUALIZATION_API_PATH.length).replace(/^\//, '');
  let parts: string[];
  try {
    parts = suffix.split('/').map((part) => decodeURIComponent(part));
  } catch {
    return undefined;
  }
  const [sessionId, artifactId, first, second, ...rest] = parts;
  if (sessionId === undefined || artifactId === undefined || first === undefined || rest.length > 0) return undefined;
  if (first === 'index.html' && second === undefined) return { sessionId, artifactId, relativeFile: first };
  if (first === 'assets' && second !== undefined) {
    try {
      return { sessionId, artifactId, relativeFile: join('assets', validateAssetName(second)) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function apply(ctx: Context): void {
  const rememberedSessionDirs = new Map<string, string>();
  const disposeTool = ctx.tools.register(createVisualizationTool(ctx, rememberedSessionDirs));
  const disposeSkill = ctx.skills.register({
    name: SKILL_NAME,
    description: '创建可在对话中直接交互的 HTML 图表、图示、模拟器和界面原型。',
    source: 'runtime',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  });

  ctx.inject(['webServer'], (webCtx) => {
    const route: WebRoute = {
      kind: 'prefix',
      path: VISUALIZATION_API_PATH,
      async handler(req, res) {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const request = decodeRoute(req);
        if (request === undefined) return sendJson(res, 404, { error: 'visualization artifact not found' });
        const file = await resolveArtifactFile(
          ctx,
          rememberedSessionDirs,
          request.sessionId,
          request.artifactId,
          request.relativeFile,
          AbortSignal.timeout(10_000),
        );
        if (file === undefined) return sendJson(res, 404, { error: 'visualization artifact not found' });
        try {
          const data = await readFile(file);
          const isHtml = request.relativeFile === 'index.html';
          res.writeHead(200, {
            'content-type': contentType(file),
            'content-length': data.byteLength,
            'cache-control': 'private, max-age=31536000, immutable',
            'x-content-type-options': 'nosniff',
            ...(isHtml ? {
              'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
            } : {}),
          });
          res.end(data);
        } catch {
          sendJson(res, 404, { error: 'visualization artifact not found' });
        }
      },
    };
    webCtx.webServer.register(route);
  });

  ctx.effect(() => () => {
    rememberedSessionDirs.clear();
    disposeSkill();
    disposeTool();
  });
}
