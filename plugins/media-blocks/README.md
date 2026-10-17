# @dfy-plugins/dsh-media-blocks

DeepSeek Harness 的可扩展媒体引用层。对话日志只保存轻量 `dfy-media` 块和资源引用，二进制内容留在资源存储中；聊天界面再把引用投影成可预览的媒体卡片。

当前图片链路：

- 选择、拖入和粘贴图片继续使用 Harness 官方输入框交互。
- 旧版发送入口把官方草稿图片保存进 `ctx.attachments`，持久化为自定义媒体块。
- DSH 0.2.1 的聊天记录复用官方用户内容 Factory，保留附件顺序、引用与敏感文本遮挡；旧版使用插件画廊。历史 DFY 图片引用仍通过自己的资源接口加载。
- 请求多模态模型时，临时投影成官方 `image` block，模型直接接收像素。
- 文本模型只有在另外提供可用引用适配器时才能走媒体降级；未配置适配器时保留官方图片能力错误。
- 历史媒体引用与官方原生图片都遵循当前模型能力和已安装适配器的限制。视觉理解插件已停止维护，不作为本插件的安装要求。

在 `0.1.5-alpha.1` 上，支持图片的模型继续走官方原生上传。明确不支持图片的模型，
在官方校验拒绝后才转交已配置的引用适配器；保留原生文件凭据的会话归属检查、
混合附件顺序、请求去重、steer/queue、时区及远程调用方身份。等待队列不会把不同调用方的上下文混在一起。未配置可用路由时保留原错误。
PTC 模式下按当前 Agent 的受限工具目录选择适配器，不把子工具额外暴露到模型的 wire schemas。

## 扩展协议

`MediaResourceMap` 可通过 TypeScript declaration merging 增加 `audio`、`video`、`canvas`、`code` 或业务自定义格式；`registerReferenceAdapter(kind, adapter)` 决定某类资源如何进入不原生支持它的模型上下文。引用适配器只负责资源投影，不接管输入框、存储或聊天渲染。

音频、视频、沙箱 HTML/Canvas 和代码运行卡片会复用这一协议，但执行能力必须由独立 Host 插件提供：媒体块只描述和展示资源，不在 WebView 里直接执行任意代码。

## 本地安装

```bash
dsh plugin --profile web add /path/to/dfy-dsh-plugins/plugins/media-blocks
```

推荐使用模型原生多模态能力。`@dfy-plugins/dsh-vision` 已停止维护并撤回发布，不再建议安装。

## 构建与测试

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

当前维护版本需要 DeepSeek Harness `0.1.7-alpha.1` 或更高版本；已对实际 `0.2.1-rc.2` 运行时验证。
