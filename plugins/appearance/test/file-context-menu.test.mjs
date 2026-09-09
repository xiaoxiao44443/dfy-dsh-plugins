import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../src/client.tsx', import.meta.url))],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime'],
});

class FileButton {
  constructor(path, scope, { produced = false, disabled = false, title = true } = {}) {
    this.path = path;
    this.parentElement = scope;
    this.produced = produced;
    this.disabled = disabled;
    this.title = title;
    this.textContent = path.split(/[\\/]/u).at(-1);
    this.clicks = 0;
  }

  getAttribute(name) {
    if (name === 'title') return this.title ? this.path : null;
    if (name === 'aria-label') return this.produced ? null : `打开 ${this.path}`;
    return null;
  }

  closest(selector) {
    if (selector === 'button') return this;
    if (selector === '[data-produced-files-row="true"]') return this.produced ? this.parentElement : null;
    return null;
  }

  click() { this.clicks += 1; }
}

function fileMenu(path, { cwd, artifacts = [], visualizationContainer = false, ...buttonOptions } = {}) {
  const body = {
    parentElement: null,
    matches: () => false,
    querySelectorAll: () => artifacts.map(({ url, source }) => ({
      dataset: { dshArtifactUrl: url, dshSourceFile: source },
    })),
  };
  const scope = visualizationContainer ? {
    parentElement: body,
    matches: (selector) => selector === '[data-dsh-visualization-output], [data-dsh-artifact-content="visualization"]',
    querySelectorAll: body.querySelectorAll,
  } : body;
  const button = new FileButton(path, scope, buttonOptions);
  // File links can be right-clicked on the icon/text nested in the official button.
  const context = { target: { closest: (selector) => button.closest(selector) } };
  const module = { exports: {} };
  runInNewContext(built.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    URL,
    HTMLButtonElement: FileButton,
    document: { body, baseURI: 'http://127.0.0.1:57841/' },
    navigator: { platform: 'Win32' },
  });
  const contributions = [];
  const ctx = {
    get: (name) => name === 'sessions' ? {
      list: { getSnapshot: () => ({ current: 'session', byId: { session: { cwd } } }) },
    } : undefined,
    desktopContextMenu: { register: (contribution) => {
      contributions.push(contribution);
      return () => {};
    } },
    effect: () => {},
    inject: (_names, callback) => callback({ ...ctx, effect: (setup) => setup() }),
    settingsScope: { bind: () => ({}) },
    slots: { inject: () => {} },
  };
  module.exports.apply(ctx);
  const open = contributions.find((entry) => entry.id === 'appearance.open-file');
  assert.ok(open);
  assert.equal(open.when(context), true);
  return { open, context, button };
}

test('ordinary HTML file links expose the original local file URL for browser menus', () => {
  const cases = [
    ['E:\\项目 文件\\播放器 #100%.html', undefined,
      'file:///E:/%E9%A1%B9%E7%9B%AE%20%E6%96%87%E4%BB%B6/%E6%92%AD%E6%94%BE%E5%99%A8%20%23100%25.html'],
    ['player.HTM', 'C:\\workspace\\web pages', 'file:///C:/workspace/web%20pages/player.HTM'],
    ['../player.xhtml', 'E:\\workspace\\pages', 'file:///E:/workspace/player.xhtml'],
    ['/home/user/web pages/player #100%.html', undefined,
      'file:///home/user/web%20pages/player%20%23100%25.html'],
    ['/tmp/name\\with-backslash.html', undefined, 'file:///tmp/name%5Cwith-backslash.html'],
  ];
  for (const [path, cwd, expected] of cases) {
    for (const produced of [false, true]) {
      const { open, context } = fileMenu(path, { cwd, produced });
      assert.equal(open.linkURL(context), expected, `${path}, produced=${produced}`);
    }
  }
});

test('files without browser targets retain only their ordinary file actions', () => {
  for (const [path, cwd] of [
    ['C:\\workspace\\notes.md'],
    ['/tmp/image.png'],
    ['C:\\workspace\\player.html.txt'],
    ['player.html'],
    ['C:player.html'],
    ['\\\\server\\share\\player.html'],
    ['//server/share/player.html'],
    ['https://example.com/player.html'],
    ['https://example.com/player.html', 'C:\\workspace'],
    ['file:///C:/workspace/player.html', 'C:\\workspace'],
    ['C:player.html', 'C:\\workspace'],
  ]) {
    const { open, context } = fileMenu(path, { cwd });
    assert.equal(open.linkURL(context), '', path);
  }
});

test('ordinary HTML stays local when an unrelated visualization is displayed beside it', () => {
  const artifactURL = 'http://127.0.0.1:57841/api/dsh-visualize/artifacts/session/id/index.html';
  for (const visualizationContainer of [false, true]) {
    for (const source of ['C:\\workspace\\b.html', 'C:\\different-folder\\a.html']) {
      const { open, context } = fileMenu('C:\\workspace\\a.html', {
        visualizationContainer,
        artifacts: [{ url: artifactURL, source }],
      });
      assert.equal(open.linkURL(context), 'file:///C:/workspace/a.html');
    }
  }
});

test('published visualization URLs keep their precedence when their source matches the clicked file', () => {
  const artifactURL = 'http://127.0.0.1:57841/api/dsh-visualize/artifacts/session/id/index.html';
  for (const source of ['C:\\workspace\\b.html', 'b.html']) {
    const { open, context } = fileMenu('C:\\workspace\\b.html', {
      artifacts: [{ url: artifactURL, source }],
    });
    assert.equal(open.linkURL(context), artifactURL);
  }
});

test('a visualization without source metadata is used only within its own visualization container', () => {
  const artifactURL = 'http://127.0.0.1:57841/api/dsh-visualize/artifacts/session/id/index.html';
  for (const visualizationContainer of [false, true]) {
    const { open, context } = fileMenu('C:\\workspace\\a.html', {
      visualizationContainer,
      artifacts: [{ url: artifactURL }],
    });
    assert.equal(open.linkURL(context), visualizationContainer ? artifactURL : 'file:///C:/workspace/a.html');
  }
});

test('Open File still invokes the official file button and preserves its disabled state', () => {
  const { open, context, button } = fileMenu('C:\\workspace\\player.html', { title: false });
  assert.equal(open.enabled(context), true);
  assert.equal(open.linkURL(context), 'file:///C:/workspace/player.html');
  open.onSelect(context);
  assert.equal(button.clicks, 1);
  button.disabled = true;
  assert.equal(open.enabled(context), false);
});
