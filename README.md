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
- [`@dfy-plugins/dsh-media-blocks`](plugins/media-blocks)：提供持久聊天媒体块和可扩展的多媒体展示；上传入口使用 DSH 自带的附件按钮，不再添加重复的图片按钮。图片基础协议来自公共库，未来视频、网页等块仍可通过 `MediaResourceMap` 扩展。
- [`@dfy-plugins/dsh-vision`](plugins/vision)：通过独立视觉路由为文本模型分析图片，主会话只接收文字结果。
- [`@dfy-plugins/dsh-image-generation`](plugins/image-generation)：通过按需 Skill 和固定工具调用独立图片模型，支持官方图片块、参考图编辑与 Tool 内图片预览；media-blocks 为可选增强。
- [`@dfy-plugins/dsh-visualize`](plugins/visualize)：通过 `dfy-visualize` Skill 和 `dfy_visualize_render` 工具，将工作区 HTML 安全发布为对话内可交互的会话级可视化产物。
- [`@dfy-plugins/dsh-codex-bridge`](plugins/codex-bridge)：通过本机鉴权 MCP 将 Harness 会话、工具与 Skills 提供给 Codex；DSH 端与 Codex 伴生插件分别安装。
- [`@dfy-plugins/dsh-turn-guard`](plugins/turn-guard)：为单轮任务提供收敛提醒、重复调用检测和可配置的硬停止预算。

插件的 peer 范围已加入 `0.1.5-alpha.1`，但该版本的完整适配仍在进行，
不能把安装成功或构建通过当作全部功能兼容。开发依赖保留 `0.1.1-rc.2`，
目前已适配持久化快照、最新日志代读取、媒体文字渲染和 PTC 工具结果关联；
桥接审批、实时流式输出、原生上传转接及 PTC 图片引用已完成代码修复和回归验证。
真实模型调用和完整界面操作仍需在新版客户端验收。
各插件的验证范围和未完成事项见[兼容检查记录](docs/compatibility-0.1.5-alpha.1.md)。
本轮版本号及功能变化见 [DSH 0.1.5-alpha.1 配套更新说明](docs/releases/dsh-0.1.5-alpha.1.md)。

所有发布包使用 `@dfy-plugins` npm scope；运行时 ID、API、CSS 和持久化目录按各自的兼容性要求命名，
不会随包名做全局替换。新增或修改插件前请先阅读：

- [`DEVELOPMENT.md`](DEVELOPMENT.md)：客户端 HMR、样式和资源生命周期规范。
- [`NAMING.md`](NAMING.md)：发布包、运行时 ID、API、CSS 和数据目录命名规范。

## 开发

### 桌面端插件目录

根目录的 [`catalog.json`](catalog.json) 供桌面端“DFY 插件”页读取。`version` 是目录格式版本，当前为 `1`；`plugins` 数组顺序即展示顺序，每项包含 `name`（npm 包名）、`title`（中文名称）、`category`（分类）、`description`（简介）、`repository`（该插件的 GitHub 目录或仓库地址），可选 `note`（安装后的配置提示）。卡片上的 GitHub 图标打开各自的 `repository` 地址。目录不保存 npm 版本号，桌面端会查询最新发布版本。

新增插件时，先发布对应的 npm 包，再将条目加入目录并推送到 `main`。桌面端刷新即可发现，无需发布新版客户端。只列出可安装的 `@dfy-plugins/` 插件，公共依赖不进入目录。运行 `pnpm catalog:check` 校验字段、重复包名及对应插件包。

发布准备、npm 首次上传和 GitHub Actions 可信发布见 [npm 发布指南](docs/npm-publishing.md)。

```bash
pnpm install
pnpm check
pnpm build
```

针对准备发布的实际 DSH 运行环境，额外核对运行文件的具名导出（包括仅存在于前端 bundle 的模块）：

```bash
node scripts/check-runtime-exports.mjs ../dfy-dsh-desktop/build/harness-runtime
node scripts/test-runtime-compat.mjs ../dfy-dsh-desktop/build/harness-runtime
```

前者核对具名导出，后者使用目标 DSH 的 AgentLoop、ToolRuntime、审批服务和 Session
Controller 做内存集成测试。两者均不调用真实模型或读写用户对话；它们不替代界面交互及热更新验收。

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
