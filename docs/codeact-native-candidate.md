# 单一原生 execute 候选验收

## 发布状态

2026-11-05：仅候选，不接入正式桌面，不构建或覆盖安装包，不推送。
用户已决定最终模型只看到一个 execute；同时要求充分验证后再上正式。当前不保留双协议为长期产品配置，旧协议只作为未切换的正式实现与对照。

候选入口 `src/pimoon/codeact/native-candidate.ts`，仅隔离集成测试和显式 `--apps=pimoon-native` 的在线基准引用。无生产入口导入。

## 已实现

- 原生 JSON 参数 code、desc、可选 confirm；SDK 解码、schema 校验，源码不二次反转义。
- prepareLoadout 隐藏内部工具声明但保留 callable 集合，模型仅见 execute；Python 获得内部函数目录，不包含 execute 自身。
- 成功 toolUse 后执行；beforeToolCall 检查整个响应，多个调用在任何一个开始前拒绝。内部函数不能由模型直接调用。
- 复用 Runtime、路径保护、内部 SDK 审批、整块意图确认、取消；结果使用真实 toolResult 和调用 ID，nestedCalls 由 SDK 记录。
- 原生会话可持久化重开，Python 状态丢失有提示，不重放写入；旧文本执行历史明确拒绝继续。
- 不启用截流、不异步提前执行，不伪造成功终态。

当前隔离候选复制了旧执行内核的必要方法，避免实验重构影响生产；正式迁移前需合并执行内核并移除旧协议，不能长期保留两份。

## 定向验证

`node scripts/test-isolated.mjs node_modules/vitest/vitest.mjs run tests/pimoon/native-codeact-candidate.test.ts tests/pimoon/codeact-confirmation.test.ts tests/pimoon/codeact-stream.test.ts tests/pimoon/codeact-stop.test.ts tests/pimoon/codeact-usage.test.ts tests/pimoon/live-tools-cli.test.ts`

上述 6 个测试文件共 63 项全部通过；隔离 `tsc --noEmit` 通过。没有运行弹窗测试、正式 GUI 或全量 E2E。

候选 20 个用例：单工具声明、多轮 Python 状态、真实工具结果回填、确认批准/拒绝/缺失/取消/上下文失效、内部拒绝、隐藏函数直调、递归、多调用整轮拒绝、length/error/aborted、执行中取消、持久化重开、GUI 生命周期投影、Unicode/转义/旧 XML 标记、无效参数、旧历史拒绝。

SDK 的 length 会生成“未执行”的错误 toolResult，可能继续请求模型，测试只保证该截断响应不执行，不宣称整个代理永远不再生成下一次调用。

## 在线业务对照

Sol / low / SSE / runtime prompt。三个真实文件业务场景，各三轮、每轮两组独立会话，交错顺序，共 18 会话、81 次模型请求。输入输出及用户配置均隔离；只读访问凭据，不刷新、不落盘。基准按实际工作树运行，包含任务开始时已有的 Runtime/遥测未提交变更，两组相同；未提交这些其他改动。

结果：
- `.tmp/tests/live-tools/run-RifkFd/results.json`（一轮）
- `.tmp/tests/live-tools/run-8ye05F/results.json`（追加两轮）
- 两次 manifest 均记录 sourceAuthUnchanged=true。

| 指标 | 正式纯文本 | 原生候选 |
| --- | --- | --- |
| 业务文件结果正确 | 9/9 会话 | 9/9 会话 |
| 完整 usage 响应 | 12/41 | 40/40 |
| 发票汇总耗时中位数 | 26.085s | 20.795s |
| 条件编辑耗时中位数 | 37.155s | 29.371s |
| 定位编辑耗时中位数 | 17.818s | 15.382s |
| 九会话总耗时 | 237.625s | 202.560s |
| 可见 token 本地估算总量 | 86040 | 87573 |

总耗时下降约 14.8%，可见 token 估算增加约 1.8%。每场景仅三轮，不能外推稳定提速或计费节省；正式组 usage 丢失，不能用其较小账面数字与候选完整用量直接比较。

业务最终成功不等于全程无错误：两组都出现过缺失文件读取或编辑前未建立读取观测，模型随后纠正；executionErrors 包含根执行和内部调用，不能直接当成独立失败次数。文件验证检查必要输出及未应修改文件，不能证明所有可能副作用都被覆盖。

## 接入中已验证的 SDK 边界

- 显式 tools 允许列表必须包含 execute，仅注册和 setActiveTools 不会绕过列表。
- prepareLoadout 隐藏声明仍保留内部 callable 和历史激活集合；不能简单清空全部内部工具。
- ExtensionToolContext 的方法不能依赖对象展开复制；实际执行器需显式绑定 executeTool。
- strict=require 在不支持严格采样的供应商会本地拒绝；候选使用 prefer，始终保留 SDK 参数校验及空白校验。
- 同一轮循环捕获 streamFunction，修改 agent 属性不能让模拟响应只返回一次；故障夹具用闭包记录已发送。

## 尚未通过的上线门槛

1. GUI Python 卡片、源码生成态、确认等待态、停止/失败历史、嵌套 diff 和大输出图片引用已完成组件及投影验证；仍未做真实桌面渲染或无头浏览器交互验收。
2. 原生 SDK 生命周期已接入执行事实与报告分类，不另发旧 CODEACT_EXECUTION 事件，成功/失败/拒绝均验证一个根记录。裁剪、压缩摘要和旧会话只读边界仍未完成候选全链路验证。
3. MCP/动态工具加载、工具集变更、长会话、多供应商与网络异常尚未完成验收；当前在线数据仅 Sol。
4. 本地 OpenAI completions SSE 已验证参数 JSON 分片、length 半截拒绝和生成中取消；Responses/Codex 及其他供应商异常流矩阵仍需覆盖。
5. 切换前整理共同 Runtime/权限代码，删除旧 XML 解析、截流和自定义结果回填路径，明确旧会话不能继续执行；不为迁移偷改真实用户会话。
6. 完成上述验收后才讨论切正式，不因本轮速度和 usage 改善提前发布。

## 第二阶段：展示与遥测（2026-11-05）

- 原生 execute 使用 Python 专用卡片和执行/内部函数分层计数，不再多套通用工具折叠；保留真实 data-tool 名字。
- 确认进度通过 SDK onUpdate 的 details 传递，不污染模型参数或历史；同一调用 ID 从生成到完成只显示一个根卡片。
- 大结果引用预览只保留执行 outcome/executed 状态，避免已取消或已拒绝历史丢失状态；完整输出和图片仍按引用读取。
- 候选安装请求遥测；原生 toolcall_end 记录源码流结束，真实工具事件记录执行，不重复发旧文本专用事件。
- TelemetryService 为 execute 注册 codeFacts，报告将 execute 纳入 Python 执行分组；确认未执行分类与 executed 字段保留。
- 追加真实本地 SSE 参数分片、截断和生成中取消测试，参数流期间文件不存在；此阶段无新增在线模型调用。

验证：

`node scripts/test-isolated.mjs node_modules/vitest/vitest.mjs run tests/pimoon/native-codeact-candidate.test.ts tests/gui/host/projection tests/gui/frontend/features/chat/tools/codeact-ui.test.ts tests/gui/frontend/features/chat/transcript tests/harness/telemetry/telemetry.test.ts tests/pimoon/codeact-confirmation.test.ts`

16 文件、160 项通过。隔离 tsc --noEmit 通过。组件采用 React 静态渲染与 DOM 断言，没有启动浏览器、GUI 窗口或正式桌面。

工作区已有报告/Runtime 重构继续保留。本次共享报告分析器与 code-facts 的索引仅提交 execute 分类、executed 字段的最小变更；没有夹带用户其他未提交重构。测试结果基于当前工作树，不声称验证了仅 HEAD 的干净构建。正式入口仍未引用候选。
