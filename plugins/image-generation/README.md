# @dfy-plugins/dsh-image-generation

为 DeepSeek Harness 提供独立的图像生成与编辑能力：主对话模型先加载 `dfy-image-generation` Skill，再调用固定的 `dfy_image_generate` 工具；真正的图片模型只保存在插件设置中，不注册进主对话模型列表。

当前支持 OpenAI Images API 兼容路由：

- 无输入图片时调用 `POST /images/generations`。
- 带附件引用或工作区图片路径时调用 `POST /images/edits`。
- 结果按内容哈希保存到当前 `session-*/artifacts/images/<sha256>`，归档永久删除会随会话目录一并清理；插件自己的 Tool 卡片可直接预览。
- 用户上传和其他输入图片仍使用 Harness 官方 attachment。旧版生图 attachment 结果继续兼容回放。
- 预览兼容 DSH 0.1.5 的 `meta.images`、旧版 `resultView` 和 PTC 子调用的图片结果文本；历史记录无需重新生图。
- `@dfy-plugins/dsh-media-blocks` 是可选增强：安装时提供跨模型引用适配，未安装时生图和预览仍可独立工作。
- API Key 独立保存在 `dsh-credentials`，不进入插件设置和模型上下文，也不会在设置页回显。

## 安装

图像生成插件可以独立安装：

```bash
dsh plugin --profile web add ./plugins/image-generation
```

需要让已上传图片在原生多模态、视觉插件和文本模型之间动态投影时，可再安装 `./plugins/media-blocks`。

重启 Harness 后，在“设置 → 插件 → 图像生成”中填写：

- API Base URL，例如 `https://api.teamorouter.com/v1`
- API Key
- 图像模型，例如 `gpt-image-2`
- 默认质量与尺寸

设置页会把密钥写入此插件专用的 Harness 凭据项。再次打开时只显示“已配置”；留空会保留原值，输入新值会替换原值。
