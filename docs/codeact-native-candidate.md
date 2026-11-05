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

1. GUI 专用代码卡片仍按 codeact 名称识别，execute 仅验证了通用生命周期投影。需适配流式 JSON 参数、确认等待态、代码和结果展示，并用无头组件/定向界面测试验收。
2. 专用执行事件、报告归因、裁剪、压缩摘要和旧会话只读边界未完成候选全链路验证。
3. MCP/动态工具加载、工具集变更、长会话、多供应商与网络异常尚未完成验收；当前在线数据仅 Sol。
4. 原生流参数分片、半截 JSON 与取消的完整供应商适配矩阵仍需专项覆盖。
5. 切换前整理共同 Runtime/权限代码，删除旧 XML 解析、截流和自定义结果回填路径，明确旧会话不能继续执行；不为迁移偷改真实用户会话。
6. 完成上述验收后才讨论切正式，不因本轮速度和 usage 改善提前发布。
