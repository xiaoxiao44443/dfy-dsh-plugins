# DFY DSH Plugins

个人维护的 DeepSeek Harness 插件集合。仓库使用 pnpm workspace 管理，每个插件都保留独立的 `package.json`、README、版本号、构建和测试脚本。

## 公共库

- [`@dfy-plugins/resource-core`](packages/resource-core)：普通 npm 库，提供版本化不透明资源引用、进程内 provider 注册表和安全文本降级；它不是 Harness 插件。
- [`@dfy-plugins/image-protocol`](packages/image-protocol)：普通 npm 库，提供 rc.8 官方图片块、Attachment 图片引用、格式识别和图片结果降级；它不是 Harness 插件。

插件可以独立发布并声明这些库为普通依赖。进程内注册表使用稳定的 `Symbol.for` ABI，因此各插件即使各自打包了一份 `resource-core`，仍共享 provider，不需要依赖 media-blocks 的私有协议。

## 插件

- [`@dfy-plugins/dsh-archive-manager`](plugins/archive-manager)：按项目查看已归档对话，支持取消归档和永久删除。
- [`@dfy-plugins/dsh-appearance`](plugins/appearance)：在设置侧栏提供独立“外观”页，可在回复完成后折叠过程轨迹并调节对话字号。
- [`@dfy-plugins/dsh-wallpaper`](plugins/wallpaper)：为 Harness 设置可配置图片背景，支持多种适应模式、模糊、遮罩和界面透明度。
- [`@dfy-plugins/dsh-media-blocks`](plugins/media-blocks)：提供持久聊天媒体块和可扩展的多媒体展示；图片基础协议来自公共库，未来视频、网页等块仍可通过 `MediaResourceMap` 扩展。
- [`@dfy-plugins/dsh-vision`](plugins/vision)：通过独立视觉路由为文本模型分析图片，主会话只接收文字结果。
- [`@dfy-plugins/dsh-image-generation`](plugins/image-generation)：通过按需 Skill 和固定工具调用独立图片模型，支持官方图片块、参考图编辑与 Tool 内图片预览；media-blocks 为可选增强。
- [`@dfy-plugins/dsh-visualize`](plugins/visualize)：通过 `dfy-visualize` Skill 和 `dfy_visualize_render` 工具，将工作区 HTML 安全发布为对话内可交互的会话级可视化产物。
- [`@dfy-plugins/dsh-codex-bridge`](plugins/codex-bridge)：通过本机鉴权 MCP 将 Harness 会话、工具与 Skills 提供给 Codex；DSH 端与 Codex 伴生插件分别安装。
- [`@dfy-plugins/dsh-turn-guard`](plugins/turn-guard)：为单轮任务提供收敛提醒、重复调用检测和可配置的硬停止预算。

所有发布包使用 `@dfy-plugins` npm scope；运行时 ID、API、CSS 和持久化目录按各自的兼容性要求命名，
不会随包名做全局替换。新增或修改插件前请先阅读：

- [`DEVELOPMENT.md`](DEVELOPMENT.md)：客户端 HMR、样式和资源生命周期规范。
- [`NAMING.md`](NAMING.md)：发布包、运行时 ID、API、CSS 和数据目录命名规范。

## 开发

```bash
pnpm install
pnpm check
pnpm build
```

本地安装归档插件：

```bash
dsh plugin --profile web add ./plugins/archive-manager
```

本地安装外观插件：

```bash
dsh plugin --profile web add ./plugins/appearance
```

本地安装壁纸插件：

```bash
dsh plugin --profile web add ./plugins/wallpaper
```

本地安装视觉插件：

```bash
dsh plugin --profile web add ./plugins/media-blocks
dsh plugin --profile web add ./plugins/vision
```

本地安装图像生成插件：

```bash
dsh plugin --profile web add ./plugins/image-generation
```

本地安装可视化插件：

```bash
dsh plugin --profile web add ./plugins/visualize
```

本地安装 Codex Bridge 的 DSH 端：

```bash
dsh plugin --profile web add ./plugins/codex-bridge
```

本地安装任务守卫插件：

```bash
dsh plugin --profile web add ./plugins/turn-guard
```

将仓库添加为 Codex Plugin Marketplace：

```bash
codex plugin marketplace add xiaoxiao44443/dfy-dsh-plugins
```

然后在 Codex 桌面端的插件列表中打开 **DFY DSH Plugins**，安装 **DFY DSH**。安装或更新后请新建 Codex 任务；已经打开的任务不会热加载插件和 MCP。

## 许可证

本仓库中的插件和公共库基于 [MIT License](LICENSE) 开源。DeepSeek Harness 及其他第三方依赖仍分别遵循其各自的许可证。
