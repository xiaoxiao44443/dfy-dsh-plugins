# 插件开发规范

## 客户端样式与 HMR

Harness 的 Client 插件热更新时，新实例的安装与旧实例的清理可能短暂交错。所有客户端资源都必须按“实例拥有资源”的原则管理：新实例只能替换旧资源，旧实例清理时只能删除自己创建的资源。

### 普通 Client 插件

插件级 CSS 应由 `ctx.effect()` 统一安装，不应把全局 `<style>` 放进 Slot 组件。推荐模板：

```tsx
const STYLE_ID = '@dfy-plugins/dsh-example';
const STYLES = `/* ... */`;

function installStyles(): () => void {
  const existing = document.querySelector<HTMLStyleElement>(
    `style[data-plugin=${JSON.stringify(STYLE_ID)}]`,
  );
  const tag = document.createElement('style');
  tag.dataset.plugin = STYLE_ID;
  tag.textContent = STYLES;
  if (existing === null) document.head.appendChild(tag);
  else existing.replaceWith(tag);
  return () => tag.remove();
}

export function apply(ctx: ClientCtx): void {
  ctx.effect(installStyles, 'dsh-example: client styles');
}
```

这个写法必须同时满足两种合法顺序：

1. 旧实例先清理，新实例后安装。
2. 新实例先替换节点，旧实例后清理自己的旧节点。

禁止使用以下模式：

```tsx
// 错误：新实例复用旧节点后，旧实例仍可能把共享节点删除。
if (existing !== null) return () => {};

// 错误：Slot 组件卸载时会连同全局样式一起消失。
return <style>{STYLES}</style>;

// 错误：清理阶段按选择器删除，可能命中新实例创建的节点。
return () => document.querySelector(`[data-plugin='${STYLE_ID}']`)?.remove();
```

清理函数必须闭包持有本实例创建的具体节点，例如 `() => tag.remove()`，不能在清理时重新按全局选择器查找。

### 页面级插件

管理背景层、遮罩层、Portal 根节点等页面级资源时，可以使用 `globalThis` 保存页面控制器。相同构建的 Fiber 重建应复用控制器；插件 Bundle 自身更新时必须先完成旧控制器的同步卸载，再挂载新控制器。旧 Fiber 不应保留一个会在稍后清理新版节点的回调。

页面控制器可以长期复用，但插件级全局 CSS 仍应使用上面的独立 `ctx.effect(installStyles, ...)` 模式。不要把样式标签只安装在控制器首次 `mount()` 的分支里：客户端 HMR 可能清理旧样式后继续复用控制器，此时 `mount()` 的“已挂载”短路会留下仍在运行但完全无样式的界面。

每个 DOM 节点都应同时具备：

- 稳定的插件所有者标记，用于新控制器识别遗留节点。
- 实例内的直接节点引用，用于卸载时精确删除。

### 验证清单

涉及 Client 组件、样式或生命周期的改动完成后，必须验证：

1. 保持 Harness 页面打开，并确认 Client 插件构建监听器正在运行。
2. 打开受影响的菜单、设置卡片、按钮或悬浮窗。
3. 修改一处可见文案触发 HMR，确认功能和样式同时更新。
4. 撤回文案再次触发 HMR，确认样式仍然存在。
5. 检查同一 `STYLE_ID` 只有一个 `<style>` 节点。
6. 确认原生文件输入框等被 CSS 隐藏的控件没有意外暴露。
7. 禁用或卸载插件后，确认本实例拥有的样式和 DOM 节点被清理。

对自行注入全局 CSS 的插件，应在命名契约测试中至少固定以下事实：

- 样式由 `ctx.effect(installStyles, ...)` 注册。
- HMR 安装使用新节点替换旧节点。
- Slot 组件中不存在承载插件全局样式的内联 `<style>`。

## Host HTTP 路由生命周期

`webServer.register()` 返回清理函数，调用本身不会自动随插件卸载注销。必须在拥有该路由的 Context 上登记 effect，例如：

```ts
ctx.effect(() => ctx.webServer.register(route), 'example: HTTP route');
```

使用 `ctx.inject()` 的可选服务时，effect 应属于回调的子 Context。验证时通过官方管理器关闭、重新开启插件及整个组合包，确认没有重复路由，并保留原配置与条目停用选择。
