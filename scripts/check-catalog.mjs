import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const catalog = JSON.parse(await readFile(new URL('catalog.json', root), 'utf8'))
assert.equal(catalog.version, 1, '目录格式版本必须为 1')
assert.ok(Array.isArray(catalog.plugins) && catalog.plugins.length <= 100, 'plugins 必须是最多 100 项的数组')
const packages = new Map()
for (const dir of await readdir(new URL('plugins/', root), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const manifest = JSON.parse(await readFile(new URL(`plugins/${dir.name}/package.json`, root), 'utf8'))
  packages.set(manifest.name, manifest)
}
const seen = new Set()
for (const entry of catalog.plugins) {
  assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), '目录条目必须是对象')
  for (const [key, maxLength] of Object.entries({ name: 214, title: 48, category: 16, description: 400, repository: 500, ...(entry.note === undefined ? {} : { note: 200 }) })) {
    assert.ok(typeof entry[key] === 'string' && entry[key].trim().length > 0 && entry[key].length <= maxLength, `无效字段：${entry.name ?? '?'} / ${key}`)
    assert.equal(entry[key], entry[key].trim(), `字段不能包含首尾空格：${entry.name} / ${key}`)
  }
  assert.match(entry.name, /^@dfy-plugins\/[a-z0-9][a-z0-9._-]*$/u, '只能列出 DFY 插件包')
  assert.ok(!seen.has(entry.name), `重复包名：${entry.name}`)
  seen.add(entry.name)
  const repository = new URL(entry.repository)
  assert.ok(repository.protocol === 'https:' && repository.hostname === 'github.com' && !repository.port && !repository.username && !repository.password && /^\/[^/]+\/[^/]+(?:\/|$)/u.test(repository.pathname), `无效的 GitHub 地址：${entry.name}`)
  const manifest = packages.get(entry.name)
  assert.ok(manifest, `插件目录中不存在对应的包：${entry.name}`)
  assert.ok(typeof manifest.dsh?.bundle?.patch === 'string', `不是可安装的 DSH 插件：${entry.name}`)
}
console.log(`插件目录校验通过：${seen.size} 个插件。`)
