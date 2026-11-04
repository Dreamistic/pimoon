# 审批

当前交付范围为 Windows 桌面。Approval Gate 检查 `process_run`、`write`、`edit`、`http`、`webfetch` 及保留的 Bash 入口；工具获准后仍需通过路径、版本、网络等自身检查。

## 执行链路

1. `tool_call` 确定性审查。允许则继续，明确拒绝则结束，不提供批准入口。
2. 需要审批时，仅返回 `approval_required`、一次请求 ID、原因和可选范围；被拦截的调用没有执行。代码块此前已完成的操作不回滚。
3. AI 调用 `approval(request_id, reason, scope)`，说明目的、风险并建议运行时已提供的范围。
4. GUI 在输入框上方展示非模态审批条：真实操作摘要、可展开的完整操作、AI 说明、实际授权范围及补充意见。用户可改变建议范围，或一次提交拒绝与意见，不再弹第二个输入框。
5. `approval` 只返回实际决定，不执行原操作。批准后 AI 仅重试被拦截的具体调用，不重放整段代码。

函数面板需启用 `approval`；Vanilla、Offline 和 Web Chat 预设均包含它。已有自定义默认列表不自动扩展，可手动启用或重新应用预设。

整段 CodeAct 的 `confirm` 与权限审批共用审批条，但只用于澄清用户意图，不授予内部操作权限。不能用它代替具体权限提案，否则内部调用仍可能被拦截。

## 默认策略

- 普通文件读写通常直接执行，覆盖前读取及版本保护不属于可审批豁免项。
- `process_run` 默认需要审批，不借用 Bash 的静态分类结果隐式放行查询、测试或构建程序。
- 私网 HTTP/webfetch origin 需要审批；HTTP 下载还检查目标路径。
- 保留的 Bash 入口按安全事实处理删除、重置、包安装、发布、提权等风险；它不进入桌面 CodeAct 函数集合。
- 可证明只影响临时目录的写入可豁免确认；明确拒绝规则优先。

完整分类器与默认值见 [`approval-gate.jsonc`](../../../agent/defaults/approval-gate.jsonc)。外部程序得到许可后使用宿主权限，审批不是操作系统沙箱，也不固定程序或脚本文件的内容。

## 授权范围

| UI 选择 / `scope` | 效果 |
| --- | --- |
| 仅本次 / `once` | 下一次完全相同的调用；绑定原请求、完整参数、工作区、会话和策略版本，只消费一次 |
| 本会话相同操作 / `session` | 保存当前敏感单元的精确匹配规则，仅属于此逻辑会话 |
| 以后按所示规则 / `persistent` | 原子保存运行时生成并展示的保守规则；不是所有工具或整个目录的无条件许可 |
| 拒绝 | 不执行；可附意见，同一任务不反复申请相同操作 |

Bash/进程命令规则绑定工作目录。`process_run` 的持久规则仅精确匹配相同 argv 和空环境覆盖；带 `env` 覆盖的请求不提供持久选项，不生成进程参数前缀通配。继承环境及程序内容不属于此匹配保证。文件规则按路径匹配，不限制新正文，但版本检查继续生效；私网规则按完整 origin 匹配。实际范围始终以 UI 展示的规则为准。

持久保存失败会明确降为 `once`，结果包含 `persistence_failed`，不假称已经永久授权。持久规则可能包含命令参数，含秘密或私密 payload 的请求不要选择持久保存。会话诊断只额外记录请求散列、决定、实际范围和是否有意见，不复制完整操作或意见正文。

请求 ID 不构成授权。当前任务最多保留 128 个请求，待审批请求及一次票据最多有效 30 分钟；新用户轮次、会话更换、历史导航或重启后失效。UI 等待同时受配置超时及 CodeAct 外层预算约束。审批提交前复核会话、分支、配置、取消状态；持久写入在原子替换前再次复核。后台命名、书签、用量和审批审计不使有效提案失效。

拒绝、取消、超时和上下文失效不生成许可；相同请求在收到新的用户指令前不再次弹出。重复响应不能重复消费，断线重连只恢复展示，不重放操作。无界面默认阻止；显式 `ui.non_interactive=allow` 仍不能覆盖明确拒绝规则。

## 与自主记忆的关系

完成的审批结果把真实决定、实际范围和用户意见返回模型，供 AI 自主判断是否用普通文件工具记录可复用经验。候选提案、取消和一次允许不能被写成长期同意。不会自动抄录每次审批或强制额外总结轮次。

Markdown 永远不是执行凭证。只有审批存储中的确定性规则、或尚未消费的有效一次票据，才能改变后续匹配结果；记忆关闭不关闭审批。

## 配置与检查

用户配置为 `PIMOON_HOME/agent/configs/approval-gate.jsonc`，可用 `PI_APPROVAL_GATE_CONFIG` 指定路径。持久规则默认位于 `PIMOON_HOME/agent/state/approval-gate.rules.jsonc`；相对路径基于 pimoon 的 agent 目录，不回落到原版目录。

| 字段 | 含义 |
| --- | --- |
| `enabled` | 总开关；关闭后跳过调用策略 |
| `ui.timeout_ms` | 确认超时，0 表示不额外限制；仍受请求及执行预算约束 |
| `ui.non_interactive` | 无界面时 block 或 allow，默认 block |
| `tools.<tool>.default_action` | 未命中规则时的动作 |
| `tools.bash.facts`、`tools.bash.combinations` | Bash 事实及组合 |
| `ask_rules`、`deny_rules` | 路径和工具规则 |
| `remember.allow_session`、`remember.allow_persistent` | 是否提供会话、持久范围 |
| `remember.persistent_store` | 授权存储路径 |

`/approval-check <bash command>` 只解释保留的 Bash 策略，不执行命令，也不模拟 `process_run`。

审批 UI 的请求和完成事件驱动[系统通知](../runtime/notifications.md)。[Bash 分析与规则](rules.md)记录保留的解析逻辑。实现位于 `src/harness/approval/`，装配入口为 `src/harness/extensions/approval-gate.ts`。
