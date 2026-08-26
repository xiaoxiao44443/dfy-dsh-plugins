# 插件命名规范

本仓库把“发布归属”“Harness 运行时标识”和“本机数据归属”分开命名。修改 npm 包名时，不应顺带全局替换 API、CSS、配置 ID 或已有数据路径。

## 基本格式

假设插件短名为 `<slug>`，例如 `wallpaper`、`archive-manager`、`vision`。

| 对象 | 格式 | 示例 |
| --- | --- | --- |
| npm 包名 | `@dfy-plugins/dsh-<slug>` | `@dfy-plugins/dsh-wallpaper` |
| 仓库目录 | `plugins/<slug>` | `plugins/wallpaper` |
| Client 模块加载 ID | 与 npm 包名完全一致 | `@dfy-plugins/dsh-wallpaper` |
| Cordis 组合 ID | 简短、稳定的功能名 | `wallpaper` |
| `export const name` | 简短、稳定的功能名 | `wallpaper` |
| HTTP API | `/api/dsh-<slug>/...` | `/api/dsh-wallpaper/state` |
| CSS、DOM、localStorage | `dsh-<slug>-...` | `dsh-wallpaper-card` |
| 设置命名空间 | 优先 `dsh-<slug>`；已有 ID 保持不变 | `dsh-vision` |
| 工具名 | `dfy_<slug>_<action>` | `dfy_vision_analyze`；可见标题 `DFY VISION ANALYZE` |
| Skill 名 | `dfy-<slug>` | `dfy-vision` |
| 持久化目录 | `$DSH_HOME/storages/dfy-plugins/<slug>` | `$DSH_HOME/storages/dfy-plugins/wallpaper` |

## 约束

1. `@dfy-plugins` 只负责 npm 发布归属；`dsh-` 表示这是 DeepSeek Harness 插件。
2. 工具和 Skill 位于模型可见的全局注册表，使用作者前缀避免与其他插件重名。
3. Cordis ID、API、CSS、DOM、localStorage 和设置 ID 一旦使用，就视为兼容性接口，不因包名或作者名变化而重命名。
4. 只有真正持久化独立数据的插件才创建存储目录；多个插件数据统一归入 `storages/dfy-plugins/`。
5. 已发布的 API、CSS、设置 namespace、内容块、Skill 等兼容 ID 不随 npm 品牌改名；除非明确安排一次协议迁移。
5. 不对整个插件目录执行品牌名全局替换。重命名前先列出各层标识，逐项决定哪些需要变化。
6. 不可避免的持久化路径迁移必须先验证源、目标和文件内容，并采用“读取旧位置、写入新位置”的兼容策略；不能静默丢弃配置或原文件名。

## 当前插件

| 插件 | Cordis ID | 设置 ID/命名空间 | API | 数据目录 |
| --- | --- | --- | --- | --- |
| `@dfy-plugins/dsh-archive-manager` | `archive-manager` | `archives` | `/api/dsh-archive-manager` | 无独立目录 |
| `@dfy-plugins/dsh-appearance` | `appearance` | `dsh-appearance` | 无 | 无独立目录 |
| `@dfy-plugins/dsh-wallpaper` | `wallpaper` | `wallpaper` | `/api/dsh-wallpaper` | `storages/dfy-plugins/wallpaper`（自动迁移旧目录） |
| `@dfy-plugins/dsh-media-blocks` | `media-blocks` | 无 | `/api/dsh-media-blocks` | 图片复用 Harness attachments |
| `@dfy-plugins/dsh-vision` | `vision` | `dsh-vision` | `/api/dsh-vision` | 无独立目录 |
| `@dfy-plugins/dsh-image-generation` | `image-generation` | `dsh-image-generation` | `/api/dsh-image-generation` | 图片复用 Harness attachments |
| `@dfy-plugins/dsh-turn-guard` | `turn-guard` | `dsh-turn-guard` | 无 | 无独立目录 |
