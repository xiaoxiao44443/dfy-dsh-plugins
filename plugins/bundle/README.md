# DFY 插件组合包

DSH **0.1.7-alpha.1 及以上**的原生组合包。包含壁纸、外观、归档管理、媒体内容、
图像生成、交互可视化、任务守卫和 Codex 连接，共 8 个插件。视觉理解已停止维护，不收录。

发布到 npm 后安装或更新：

```bash
dsh plugin --profile web add @dfy-plugins/dsh-bundle@latest
```

在官方“插件 → 已安装”中显示为“DFY 插件组合包”。总开关控制整包，详情页中可分别
启停各个插件。点击“图像生成”或“Codex 连接”条目可进入原生设置页。更换包版本后重启 Harness。图片模型、Codex 伴生插件仍需各自配置。

本仓库开发时先运行 `pnpm install && pnpm build`，再安装本地链接：

```bash
dsh plugin --profile web add link:/绝对路径/dfy-dsh-plugins/plugins/bundle
```

组合包依赖现有独立包，发布时固定到本次验证过的精确版本。组件更新后发布一个新组合包
版本，用户更新组合包即可取得整套版本。各独立插件继续支持按需安装。

从单独安装切换时，先停止使用该 Profile 的 Harness，移除原来的 8 个直接依赖和
`dsh.profile.bundles` 选择，再安装组合包。保留 `cordis.patch.yml`、配置和数据目录；
已停用的单独包应转成同名条目的 `disabled: true` 覆盖。组合包沿用原来的条目 ID，
已有配置及条目开关可继续使用。不要同时启用组合包和它包含的独立组合层。

桌面端从包内 `dfy.includes` 读取包含关系，仅用于展示及防重复安装；运行时的组合与启停
仍完全由 DSH 的 `dsh.bundle.patch` 和官方管理器处理。

组合包图标与桌面端左上角图标同源，使用 256×256 PNG。DSH 限制图标不超过 256 KiB；`release:prepare` 会检查图标是否随包发布、路径及文件体积。
