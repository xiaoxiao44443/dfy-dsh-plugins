# DSH 0.1.7-alpha.1 插件发布

本批插件适配 DeepSeek Harness 0.1.7-alpha.1；新安装可选择 DFY 插件组合包，也可按需独立安装。

## 更新内容

- 首次发布原生组合包：集中安装、统一更新，在 DSH 插件详情页分别启停组件；固定依赖到本批验证过的版本。
- Codex 连接和图像生成的设置入口迁入官方插件详情页，表单适配原生设置风格。
- 组合包组件补齐中文名；统一原生开关、右对齐下拉菜单和随主题变化的滑块配色；修复深色模式壁纸显示。
- 移除外观插件的“每段回复前收起过程”，使用 DSH 自带行为。
- 适配新配置树、会话投影和官方 V4 图片日志；改进插件与组合包反复启停时的路由清理。
- 视觉理解插件 dsh-vision 停止维护与发布，退出构建、发布和插件目录，npm 上的已发布版本已撤回，历史源码的 package.json 设置 private 以禁止误发布。交互可视化 dsh-visualize 继续维护。

## 发布版本

| 包（@dfy-plugins/） | 版本 |
| --- | --- |
| dsh-bundle | 0.1.0 |
| dsh-appearance | 0.1.5 |
| dsh-archive-manager | 0.1.4 |
| dsh-media-blocks | 0.1.4 |
| dsh-wallpaper | 0.1.3 |
| dsh-image-generation | 0.1.3 |
| dsh-visualize | 0.1.3 |
| dsh-turn-guard | 0.1.3 |
| dsh-codex-bridge | 0.1.3 |
| image-protocol | 0.1.3 |
| resource-core | 0.1.2 |

## 验证

- 全仓构建、类型检查和 124 项测试通过。
- 已发布的 11 个 npm 包校验值一致；从 npm 实际安装独立插件和组合包，配置合成、模块导入及移除验证通过。
- 实际 DSH 运行时导出、工具与审批行为、独立插件归档安装通过。
- 组合包启动、组件启停、整包启停及独立插件迁移验收通过。

安装组合包：`dsh plugin --profile web add @dfy-plugins/dsh-bundle@latest`。已有独立安装请先按[组合包迁移说明](../../plugins/bundle/README.md)处理重复组件。
