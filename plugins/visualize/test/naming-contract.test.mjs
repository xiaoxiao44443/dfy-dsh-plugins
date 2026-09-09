import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pluginRoot = new URL('../', import.meta.url);

test('visualize follows repository naming, lifecycle, storage and sandbox contracts', async () => {
  const [pkgRaw, patch, host, client, build] = await Promise.all([
    readFile(new URL('package.json', pluginRoot), 'utf8'),
    readFile(new URL('cordis.patch.yml', pluginRoot), 'utf8'),
    readFile(new URL('src/index.ts', pluginRoot), 'utf8'),
    readFile(new URL('src/client.tsx', pluginRoot), 'utf8'),
    readFile(new URL('scripts/build-client.mjs', pluginRoot), 'utf8'),
  ]);
  const pkg = JSON.parse(pkgRaw);
  assert.equal(pkg.name, '@dfy-plugins/dsh-visualize');
  assert.match(patch, /id: visualize\r?\n\s+name: '@dfy-plugins\/dsh-visualize'/);
  assert.match(build, /id: "@dfy-plugins\/dsh-visualize"/);
  assert.match(host, /export const name = 'visualize'/);
  assert.match(host, /const TOOL_NAME = 'dfy_visualize_render'/);
  assert.match(host, /const SKILL_NAME = 'dfy-visualize'/);
  assert.match(host, /VISUALIZATION_API_PATH = '\/api\/dsh-visualize\/artifacts'/);
  assert.match(host, /join\('artifacts', 'visualizations'\)/);
  assert.match(host, /await rename\(temporaryDirectory, finalDirectory\)/);
  assert.match(host, /presentationMeta:/);
  assert.match(host, /kind: 'prefix'/);
  assert.match(host, /content-security-policy/);
  assert.match(client, /key: TOOL_NAME/);
  assert.match(client, /sandbox="allow-scripts"/);
  assert.doesNotMatch(client, /allow-same-origin/);
  assert.match(client, /data-dsh-visualization-output/);
  assert.match(client, /data-dsh-artifact-content="visualization"/);
  assert.match(client, /data-dsh-artifact-url=\{src\}/);
  assert.match(client, /data-dsh-source-file=\{sourceFile\}/);
  assert.match(client, /hidden=\{!visible\}/);
  assert.match(client, /MAX_FRAME_HEIGHT = 4096/);
  assert.match(client, /scrolling=\{scrollable \? 'auto' : 'no'\}/);
  assert.match(client, /opacity: measured \? 1 : 0/);
  assert.match(client, /pointerEvents: measured \? 'auto' : 'none'/);
  assert.match(client, /postMessage\(\{ source: MESSAGE_SOURCE, type: 'theme', theme: currentTheme\(\) \}/);
  assert.doesNotMatch(client, /transition: height/);
  assert.match(client, /\.dsh-visualize-details\[hidden\], \.dsh-visualize-panel\[hidden\] \{ display: none !important; \}/);
  assert.match(client, /meta !== undefined \? <VisualizationFrame key=\{artifactKey\} meta=\{meta\} sourceFile=\{sourceFile\} visible=\{open\}/);
  assert.doesNotMatch(client, /open && meta !== undefined \? <VisualizationFrame/);
  assert.match(client, /onClick=\{\(\) => setDetailsOpen/);
  assert.match(client, /className="dsh-visualize-details" hidden=\{!detailsOpen\}/);
  assert.match(client, /className="dsh-visualize-inspect-action" onClick=\{inspect\}/);
  assert.doesNotMatch(client, /className="dsh-visualize-inspect" aria-label="查看可视化工具详情" onClick=\{inspect\}/);
  assert.doesNotMatch(client, /dsh-visualize-toolbar/);
  assert.doesNotMatch(client, />重新加载</);
  assert.doesNotMatch(client, /退出全屏/);
  assert.match(host, /displays the visualization after the final response/);
  assert.match(host, /## Host surface contract/);
  assert.match(host, /Keep the Host canvas itself transparent/);
  assert.match(host, /Keep the top-level visualization surface transparent and unframed/);
  assert.match(host, /structural groups and repeated content with layout, spacing, dividers, or visual marks/);
  assert.match(host, /Use a card-like surface only for a necessary bounded interactive field or concise summary/);
  assert.match(host, /never nest cards/);
  assert.match(host, /expands or collapses through interaction in normal document flow/);
  assert.match(host, /out-of-flow positioning remains appropriate for genuine overlays/);
  assert.match(host, /Do not render a heading that repeats the Tool/);
  assert.match(host, /Before publishing, inspect the HTML against the Host surface contract/);
  assert.match(host, /Keep the top-level surface transparent and unframed/);
  assert.match(host, /reserve card surfaces for necessary bounded content/);
  assert.match(client, /ctx\.effect\(installStyles, 'dsh-visualize: client styles'\)/);
  assert.match(client, /existing\.replaceWith\(tag\)/);
  assert.match(client, /React\.useState\(MIN_FRAME_HEIGHT\)/);
  assert.doesNotMatch(client, /FRAME_MEASUREMENTS/);
  assert.match(client, /<VisualizationFrame key=\{artifactKey\}/);
  assert.doesNotMatch(client, /<style>\{STYLES\}<\/style>/);
});
