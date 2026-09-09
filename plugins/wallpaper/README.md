# @dfy-plugins/dsh-wallpaper

DeepSeek Harness 图片壁纸插件。主界面使用覆盖视口的背景；应用设置面板和右侧 Sidebar
可以各自选择不同图片、设置效果，也可以共用主界面图片。两个新增区域默认不使用壁纸，
底色可用「背景不透明度」调整，默认 95%，数值越低越能透出主界面。升级保留已有图片及其设置。

## 功能

- 从本机选择图片；原图保存在 `$DSH_HOME/storages/dfy-plugins/wallpaper/assets/current`
- 覆盖、完整显示、拉伸、适应宽度、适应高度、原始居中和平铺七种模式
- 九宫格背景位置，以及随窗口缩放的横向、纵向百分比偏移微调
- 图片透明度和 0–40px 模糊
- 可配置遮罩颜色与遮罩强度
- 可配置弹窗、菜单、输入框等二级表面的填充透明度
- 在壁纸面板顶部切换「主界面 / 设置面板 / 右侧 Sidebar」，分别设置图片、布局、透明度、模糊和遮罩；主界面保留原有「界面填充」
- 设置面板和右侧 Sidebar 的「背景不透明度」范围为 0–100%，默认 95%；控制面板底色及内部控件底色，不设置壁纸时也有效。0% 去掉面板底色，100% 为不透明底色，不改变文字透明度
- 新增区域的背景来源为「不使用壁纸（默认） / 使用独立图片 / 使用主界面图片」；选择独立图片后自动启用
- Sidebar 的分栏及全屏沿用该区域背景；背景模糊只作用于图片，控件保持清晰和可操作
- 每个区域独立移除图片或恢复默认效果；关闭区域壁纸仍保留已选图片
- 无遮罩的非模态悬浮设置面板，可拖动且不妨碍操作主界面
- 设置实时预览，支持临时关闭与恢复
- 插件卸载时移除背景节点、样式和写入 body 的 CSS 变量

## 构建与测试

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
```

## 安装

```bash
dsh plugin --profile web add /path/to/dfy-dsh-plugins/plugins/wallpaper
```

重启 DeepSeek Harness 后，在「设置 → 壁纸」打开浮动面板并选择要调整的区域。配置保存在
`$DSH_HOME/storages/dfy-plugins/wallpaper/config.json`；图片只写入本机 Harness 数据目录，
不会上传到外部网络。插件升级或重新安装不会覆盖这些运行时文件。

主界面图片继续保存在 `assets/current`；设置面板和右侧 Sidebar 的图片分别保存在
`assets/settings/current`、`assets/sidebar/current`。旧图片 URL 继续有效，分区图片使用
`/api/dsh-wallpaper/image?region=settings` 或 `region=sidebar`。图片的上传、替换及删除仅作用于所选区域。
