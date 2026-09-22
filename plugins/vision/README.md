# @dfy-plugins/dsh-vision

> 已停止维护与发布。该插件已退出工作区构建、npm 发布批次和桌面插件目录；目录仅保留历史源码，以下内容为历史文档。新版 DSH 请使用模型原生多模态能力。此包已设置 `private: true`，禁止再次发布。

为 DeepSeek Harness 的文本模型提供隔离视觉能力。插件可以独立处理工作区图片、官方 Attachment 图片引用和已登记的临时资源引用；`@dfy-plugins/dsh-media-blocks` 只负责可选的聊天媒体块适配与预览增强。图片仅发送给设置中选择的视觉模型，父模型只看到工具返回的文字分析结果。

## 工作方式

1. 在 Harness「模型」页面配置一条明确声明 `image` 输入能力的视觉路由。
2. 在「设置 → 插件配置 → 视觉分析」选择 provider、model 和最大输出 Token。
3. 插件验证路由后注册：
   - 工具：`dfy_vision_analyze`（对话中显示为 `DFY VISION ANALYZE`）
   - 模型和用户均可调用的 Skill：`dfy-vision`
   - 安装 media-blocks 时额外注册 `image` 媒体引用适配器
4. 工具接受且只接受一个来源：工作区 `file_path`、官方 Attachment `image_ref`，或内置浏览器等受信 provider 返回的 `resource_ref`。
5. 安装 media-blocks 后，文本模型请求到达时引用适配器会生成模型侧提示，让模型先加载 `dfy-vision` Skill，再按 Skill 规范把引用交给工具。
6. 工具通过 `ctx.llm.stream()` 进行一次独立视觉调用，父会话只收到 `<vision_analysis>` 文字结果。

工具行的“已查看 1 张图片”摘要可直接点击：展开时显示 320×200 的原截图缩略图，收起时只保留摘要；缩略图仍可点击查看原图。若安装外观插件，图片会随它所对应的过程段在下一次可见文本输出后自动收起。

`POST /api/dsh-vision/routes` 也接受原始 PNG/JPEG/WebP/GIF 请求体，返回可直接交给 `dfy_vision_analyze.image_ref` 的持久引用。内置浏览器优先使用 `resource_ref`，视觉插件从受控进程内 provider 取得同一份 PNG 字节，不按模型提供的路径读取任意本地文件；大小、格式和像素限制仍由官方 `ctx.attachments` 校验。

当当前会话模型原生支持图片时，媒体块会直接投影为官方 `image` block，本插件不会让模型自动调用视觉 Skill 或工具。

插件不保存 API Key。认证、endpoint 和模型能力都来自 Harness 已有的模型/Provider 配置。

## 配置示例

自定义模型需要在模型设置中声明图片输入，例如：

```yaml
input:
  - text
  - image
```

未配置路由、插件被关闭，或所选模型没有明确声明 `image` 时，工具和 Skill 都不会出现在模型可用列表中。

## 构建与测试

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

## 本地安装

```bash
dsh plugin --profile web add /path/to/dfy-dsh-plugins/plugins/vision
```

需要聊天图片上传、持久媒体块和增强预览时，再可选安装 `plugins/media-blocks`。

需要 DeepSeek Harness `0.1.0-rc.8` 或更高版本。
