# DFY DSH Bridge

让 Codex 通过本机 MCP 使用 DeepSeek Harness 当前活动会话的工具与 Skills。

## 组成

- DSH Host 插件：启动仅监听 `127.0.0.1` 的随机端口，生成随机鉴权令牌，并保留 Harness 原有的工具权限与策略检查。
- DSH Client 插件：在“设置 → 插件”显示连接状态和开关。
- Codex 伴生插件：从 DSH 数据目录读取发现文件，通过 MCP 将 Harness 会话、工具与 Skills 暴露给 Codex。

桥接协议不依赖 Electron。网页、CLI 或桌面壳只要运行同一套 DSH Host 插件即可使用。

Codex 伴生插件由 Codex 自己的插件市场安装和移除，DSH 不调用 Codex CLI 管理插件。安装或更新后需要新建 Codex 任务；已经打开的任务不会热加载新插件或 MCP。

## Codex 侧工具

- `dsh_list_sessions`：列出当前运行中的 Harness 会话。
- `dsh_create_session`：创建新的 Harness 会话。默认继承最近活动会话的工作区、模型路由和 Agent 预设；也可显式覆盖 `cwd`、`workspaceId`、`provider`、`model`、`maxTokens` 与 `agentPreset`。
- `dsh_send_message`：向现有会话发送消息并立即返回 `runId`。`queue` 创建独立的后续 turn，`steer` 在最近的 step 边界注入；建议始终提供 `clientRequestId`，使网络重试不会重复发送。
- `dsh_get_run`：读取单次执行的状态、累计正文、游标后的文本/推理增量、工具调用与结果、结束原因和错误。
- `dsh_wait_run`：按 opaque cursor 做最长 30 秒的长轮询；状态或事件变化时立即返回，无变化时返回 `heartbeat: true`，不会让一个 MCP 调用长期占住连接。
- `dsh_cancel_run`：精确删除仍在 inbox 的消息；若消息已经进入 turn，则中止该 turn 并保留其他排队消息。结果明确区分 `cancelled`、`no_op` 和 `timeout`。
- `dsh_read_messages`：按数值 session event cursor 分页读取公开的消息、工具调用/结果和 turn 边界，可用于最终 transcript 或断线后的补读。
- `dsh_list_tools`：按会话读取实时 Harness 工具目录，不依赖当前 Codex 任务启动时缓存的动态 MCP 工具列表。
- `dsh_call_tool`：通过指定 Harness 会话直接调用一个实时工具，继续使用 Harness 原有的权限审批和策略检查。
- `dsh_list_skills` / `dsh_read_skill`：列出并读取所选会话的 Skills。

Harness 工具仍会按原名动态暴露，方便 Codex 使用准确的参数 Schema；`dsh_list_tools` / `dsh_call_tool` 是稳定的静态后备入口，用于会话切换或插件热加载后动态目录尚未刷新的情况。

新会话由 DSH Host 通过正式的 `agents.create` 接口创建，并附加到对应 Workspace；不是模拟前端点击，也不依赖 Electron。

DSH `0.1.5-alpha.1` 要求工具审批处于打开的 turn 内。直接工具调用现在通过 Agent
队列进入一个由 DSH 管理的轮次，在 pre-step 执行原工具管线，保留审批、拒绝和取消；
仅有桥接请求时不会调用模型。会话正在运行时会等待队列中的轮次，取消排队请求不会删除其他输入。

## 消息执行协议

`dsh_send_message` 的完成判据是该消息实际归属 turn 的持久化 `turn/end`，不是整个 Agent 暂时进入 `idle`。同一会话中的排队消息、steering 和别的 turn 因而不会串台。已经并入活动 turn 的 `steer` 无法再从该 turn 中单独剥离；取消它时会中止整个活动 turn，响应中的 `scope: "active_turn"` 会明确暴露这一范围。

推荐调用方式：

1. 用 `dsh_send_message` 提交，并保存返回的 `runId` 与 `cursor`。
2. 用该 cursor 调用 `dsh_wait_run`。若返回非终态，将新 cursor 带入下一次等待。
3. `completed`、`failed`、`cancelled` 是终态；`queued`、`running`、`cancelling` 仍需继续监控。
4. 放弃执行时调用 `dsh_cancel_run`。`timeout` 表示取消已请求但在本次等待窗口内尚未观察到 turn 收尾，可继续用 `dsh_wait_run` 确认。

`runId` 包含可恢复的消息身份。Host 插件在进程内保存更完整的运行元数据；若桥接插件重载，只要所属 Harness 会话仍处于活动状态，也能从 session event log 重建已进入 turn 的执行。`clientRequestId` 在同一会话内生成确定性的消息身份；重复提交相同内容会返回原执行，不会再次入队。

新版通过 `agent/assistant-stream` 返回实时正文和推理增量，最终与持久化 stream 对齐，
不重复返回已经收到的文字。游标保持不透明，并兼容旧两段游标。若临时输出被放弃，
`outputReset: true` 要求接收方用 `latestText` 和本次 `reasoningDelta` 替换之前累计的输出。

Codex 插件的唯一源码位于：

```text
plugins/codex-bridge/codex-marketplace/plugins/dfy-dsh
```

仓库根目录的 `.agents/plugins/marketplace.json` 直接引用该目录，不再维护第二份同步副本。

## 本机文件

默认发现文件：

```text
~/.saltfish/dfy-dsh/codex-bridge-endpoint.json
```

可用 `DSH_CODEX_BRIDGE_FILE` 覆盖位置。发现文件只包含环回地址、随机令牌和进程号，不包含模型 API Key。
