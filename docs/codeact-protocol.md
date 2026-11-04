# 文本 CodeAct

## 执行边界

```text
model text stream
-> incremental parser + execution metadata
-> completed assistant turn
-> optional block confirmation
-> persistent Python
-> internal I/O functions + validation/approval
-> custom execute_result
-> next model request
```

CodeAct 是固定执行环境，不注册执行工具。模型 API 不接收工具声明、function call 或 tool-result 角色；原生工具响应立即报错。源码在 assistant 消息中单独记录索引、执行 ID 和闭合状态；轮次边界直接运行一次，并持久化 `codeact_result` 自定义消息。GUI 使用这些元数据展示执行与内部函数调用。

内部能力沿用 SDK 校验、审批及取消，但不构造 `codemode` 调用来启动 Python。函数权限快照独立保存在 `codeact_functions` 条目中，恢复与分支导航不依赖模型工具声明。无 I/O 函数时仍可执行纯 Python。每块同步可用函数集合，不清空数据变量。

不做旧协议兼容：包含原生工具调用或工具结果的历史在请求边界被拒绝，需新建会话。

## 代码块

模型在 Markdown 围栏之外写一个 Python 块，标记必须满足：

```text
<execute desc="读取并筛选有效记录">
rows=batch("read", [{"path":p} for p in paths], limit=4)
valid=[r for r in rows if r["ok"]]
{"read":len(valid)}
</execute>
```

`paths` 须先定义。开始标记独占未缩进的一行，结束标记位于行首。完整 `</execute>` 后的同行及后续文本全部丢弃；该标记在 Python 多行字符串中也保留。解析器支持跨分片、CRLF 和 Unicode，不执行 thinking 或 Markdown 围栏中的示例。

开始行可带 `desc`（1–160 字符）和 `confirm`（1–1000 字符）两个引号属性；标题说明目的，不声明成功。不额外输出前置播报。属性不跨行，内嵌引号用 `&quot;`，支持常见 XML 实体与数字字符引用。开始行最多 4096 字符，未知、重复、空值、控制字符或损坏属性拒绝整块，不静默忽略确认。无属性块仍可执行。

`confirm="原因"` 在完整代码闭合且供应商终态有效后，暂停整块等待用户确认。GUI 输入框上方展示原因、工作区和待执行源码，可拒绝并附带意见。响应只能消费一次；确认绑定原会话、有效历史分支、工作区、解释器实例和源码，状态变化则失效；命名、书签和用量元数据不影响确认。断线重连只恢复待处理请求；重启不恢复请求，不自动重放。没有交互入口时不执行。拒绝和取消保存 `executed=false` 结果，执行耗时为零，不复用上一块指标；人工确认等待不计入代码执行预算。整块同意不替代内部函数的校验和权限审批。

缺少闭合、空块、用户取消、供应商错误或输出超限不启动代码；不会自动补齐或重放。源码上限 1 Mi 字符。保留供应商原始文本分块与有效签名，避免把一个 Responses message 重建成重复 ID 消息。

## 闭合后截流

当前 Codex Responses SDK 没有原生 `stop` 参数。解析器识别完整结束标记后，以独立取消信号截断模型流，等待宿主收尾最多五秒，再确认终态并执行。这不是用户取消，也不重放代码。用户取消、已知失败/超限或收尾超时优先阻止执行。

同批次已收到的供应商终态也会检查；自然结束不重复中断。缺少正常终态时，用量标为 `complete/partial/unavailable`，费用不按零补全。未完成的 response id、message phase 和加密推理签名不带入下一次请求。客户端取消不保证服务器立即停止或节省相同数量的计费 token。

## 自动反馈

1. 未赋值调用返回非 `None` 时自动采集，包括循环与分支中的调用；不改写函数或类内部，每个调用只执行一次。
2. 非末尾结果最多展示八个短预览，每项最多 600 字符。完整值保留在 `_results`，新结果出现时替换；长期数据应存入命名变量。
3. 最后顶层表达式按统一输出上限展示，完整值保留在 `_`。赋值和 `None` 不展示；不调用未知对象的自定义 repr。
4. `print` 不重复输出其 `None` 返回值。异常和部分函数失败始终反馈，已完成写入不回滚。
5. 静默函数调用返回紧凑计数。图片作为原始图片块转交，不编码进 Python 结果字符串。

`process_run` 默认失败抛异常，使依赖步骤停止；需要自行处理时显式 `check=False`。进程使用 argv/cwd/env，HTTP 使用 `http`，不通过 Shell/curl 包装。详见[函数环境](reference/codeact/README.md)。

## 预算与验证

单块最多 30 分钟；每批最多 256 项，同一种函数的调用有序返回。read/find/grep/ls 默认 6、最多 16 并发；process_run 默认 2、最多 4 并发，仅用于明确独立的进程任务。有依赖、共享写入或重复测速采样继续串行。进程逐项校验和审批，取消后不再派发排队项。

进程超时按代码块剩余预算预留五秒清理时间；正常的命令超时只返回函数错误，变量仍保留。外层代码块超时、用户取消和崩溃仍可重建解释器，不能承诺恢复变量或回滚写入。模型每轮请求预算仍为 20。总输出约 40k 字符，保留最多 1 Mi 字符。

节省来自减少声明重复、中间数据驻留和多步编排，不能把内部调用数减少直接当成计费或耗时收益。当前没有提供新版与旧版的供应商费用对比。

定向验证：`tests/pimoon/codeact-parser.test.ts`、`codeact-stream.test.ts`、`codeact-stop.test.ts`、`codeact-confirmation.test.ts`、`text-codeact.test.ts`、`codeact-process.test.ts`、`codeact-http.test.ts`、`codeact-headless.test.ts`、`process-budget.test.ts`、`process-batch-sdk.test.ts`、`process-orchestration.test.mjs` 与 `runtime.test.mjs`。使用真实 SDK、Python/Rust、npm CLI、JVM 合成 Wrapper 和本地 HTTP/代理服务；不运行实际 Android 构建、不请求付费模型、不启动桌面窗口。

所有验证通过 `node scripts/test-isolated.mjs ...` 隔离配置、访问凭据及临时目录。
