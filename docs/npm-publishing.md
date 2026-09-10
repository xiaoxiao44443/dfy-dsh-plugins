# npm 发布

仓库统一使用 `@dfy-plugins` scope。发布单位是 `packages/*` 的两个公共库和
`plugins/*` 的九个插件；根目录保留 `private: true`。

## 首次发布

使用具有 `dfy-plugins` 组织发布权限的 npm 账号登录，并完成 npm 要求的双重验证：

```bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm org ls dfy-plugins --registry=https://registry.npmjs.org
```

在仓库根目录构建和检查：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm release:prepare
pnpm release:test-install ../dfy-dsh-desktop/build/harness-runtime
pnpm release:dry-run
```

最后一条只预演，不上传。`release:test-install` 的参数也可以是其他含
`node_modules/@deepseek-ai/dsh` 的 DSH 0.1.5-rc.1 运行时目录。
测试使用临时 `DSH_HOME`，实际调用官方安装和移除命令、合成 Profile 配置，
并从安装后的包导入服务端入口；不启动模型，也不改动正在使用的 Profile。
首次发布前公共库尚不在 npm，测试仅在临时 Profile 中将内部依赖指向同批次归档。
这项检查不替代真实界面和模型调用验收。

确认输出的发布清单后，上传已经检查的归档：

```bash
pnpm release:publish
```

首次发布完成后，再从 npm 实际安装验证依赖解析（只安装九个插件，公共库自动下载）：

```bash
pnpm release:test-install ../dfy-dsh-desktop/build/harness-runtime --registry
```

`release/npm/manifest.json` 记录包名、版本、文件名和 SHA-512。发布脚本先核对全部
归档和 npm 上的版本，然后按依赖顺序上传，公共库与内部 peer 在使用它们的插件之前发布。
归档由 `pnpm pack` 生成，因此 `workspace:` 自动转换成普通版本依赖。
已发布且校验值相同的版本会跳过；同版本内容不同会停止，必须增加对应包的版本号。
上传中途失败可以重试，会跳过先前已成功上传的相同归档。公开发布不是多包原子操作。

构建或修改源文件后必须重新执行构建、`release:prepare` 和安装验证，不能复用旧归档。
脚本固定发布到 npm 官方 registry，安装时使用的镜像配置不会改变发布目标。

## GitHub Actions 自动发布

工作流为 `.github/workflows/publish-npm.yml`。首次创建包后，在 npm 上为**每个包**
设置 Trusted Publisher，填写：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `xiaoxiao44443` |
| Repository | `dfy-dsh-plugins` |
| Workflow filename | `publish-npm.yml` |
| Environment name | 留空 |
| Allowed actions | 允许 `npm publish` 直接发布 |

这里的 Organization or user 是 **GitHub 仓库所有者**，不是 npm 的 `dfy-plugins` 组织。
工作流使用 npm OIDC 可信发布，无需设置 `NPM_TOKEN`。

触发方式：

- GitHub Actions → **Publish npm packages** → Run workflow：默认只检查；选择 `main`
  并勾选 `publish` 才上传。
- 推送 `npm-*` 标签：测试、构建、安装验证全部通过后自动发布。例如 `npm-2026-09-10`。
  标签用于标识这一批发布，包版本仍取自各自的 `package.json`。

构建任务没有 npm 写入凭据，发布任务通过 Artifact 接收已验证的同一批 `.tgz`，
再核对校验值并上传。普通代码 push 和 PR 的 CI 只检查归档，不发布。

## 用户安装与更新

完成首次发布后，可按需安装单个插件：

```bash
dsh plugin --profile web add @dfy-plugins/dsh-wallpaper
```

一次安装全部插件（也可以重复执行来更新和补装）：

```bash
dsh plugin --profile web add @dfy-plugins/dsh-appearance@latest @dfy-plugins/dsh-archive-manager@latest @dfy-plugins/dsh-codex-bridge@latest @dfy-plugins/dsh-media-blocks@latest @dfy-plugins/dsh-image-generation@latest @dfy-plugins/dsh-turn-guard@latest @dfy-plugins/dsh-vision@latest @dfy-plugins/dsh-visualize@latest @dfy-plugins/dsh-wallpaper@latest
```

只更新已经安装的 DFY 包：

```bash
dsh plugin --profile web update "@dfy-plugins/*" --latest
```

将 `web` 替换成正在使用的 Profile。完成后重启 Harness。
Codex Bridge 的 Codex 伴生插件仍需通过 Codex Plugin Marketplace 单独安装。

参考：[npm 公开 scope 包](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)、
[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、
[pnpm workspace 发布](https://pnpm.io/workspaces#publishing-workspace-packages)。
