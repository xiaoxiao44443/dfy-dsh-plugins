# @dfy-plugins/dsh-visualize

为 DeepSeek Harness 提供 `dfy-visualize` Skill 和 `dfy_visualize_render` Tool，把工作区中的 HTML 发布成对话内可交互的可视化。

## 使用场景

适用于在对话中解释或探索交互图表、图示、模拟器、对比和界面原型，且直接展示能明显帮助理解的情况。

创建独立 HTML、SVG 动画文件、网站、应用页面、组件或修改项目，沿用正常的文件和项目工作流；不能仅因内容包含图表、动画或交互就调用本技能。用户另外要求对话内预览或探索时，再使用可视化发布工具。

## 存储

每个产物都归当前会话所有：

```text
session-<uuid>/
  session.jsonl.zstd
  artifacts/
    visualizations/
      <artifact-uuid>/
        index.html
        manifest.json
        assets/
```

归档会保留它；归档管理中永久删除对话时，整个 `session-*` 目录被删除，可视化和素材也会随之清理。

## 安全边界

- iframe 仅开放 `allow-scripts`，不开放同源、表单、弹窗和顶层导航。
- CSP 禁止网络请求、外部对象和嵌套页面。
- Host 只会从会话后端返回的绝对持久化位置中读取 artifact，路由参数不会直接拼成任意文件路径。
