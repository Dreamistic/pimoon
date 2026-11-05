# 单一原生 execute 候选验收

## 发布状态

2026-11-05：用户已明确授权验收完成后更新正式。源码已迁移至单一原生 execute，构建/安装状态见文末发布记录；以下前三阶段保留为历史验收记录，不代表当前入口仍是候选。
用户已决定最终模型只看到一个 execute；同时要求充分验证后再上正式。当前不保留双协议为长期产品配置，旧协议只作为未切换的正式实现与对照。

当前正式源码入口 `src/pimoon/codeact/session.ts`。重复候选内核、旧截流执行器和合成工具事件已删除；基准统一使用 `--apps=pimoon`。

## 已实现

- 原生 JSON 参数 code、desc、可选 confirm；SDK 解码、schema 校验，源码不二次反转义。
- prepareLoadout 隐藏内部工具声明但保留 callable 集合，模型仅见 execute；Python 获得内部函数目录，不包含 execute 自身。
- 成功 toolUse 后执行；beforeToolCall 检查整个响应，多个调用在任何一个开始前拒绝。内部函数不能由模型直接调用。
- 复用 Runtime、路径保护、内部 SDK 审批、整块意图确认、取消；结果使用真实 toolResult 和调用 ID，nestedCalls 由 SDK 记录。
- 原生会话可持久化重开，Python 状态丢失有提示，不重放写入；旧文本执行历史明确拒绝继续。
- 不启用截流、不异步提前执行，不伪造成功终态。

候选阶段曾隔离复制执行方法；正式源码切换后仅保留一个执行内核。旧历史展示、用量分析仍识别旧数据，但没有旧协议执行路径。

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
2. 原生 SDK 生命周期已接入执行事实与报告分类，不另发旧 CODEACT_EXECUTION 事件，成功/失败/拒绝均验证一个根记录。通用裁剪已保护 execute 整条记录，本地 SDK 压缩及后续执行已验证；精细输出裁剪、压缩后重开和旧会话只读边界仍未完成候选全链路验证。
3. 本地动态内部函数注册/替换、启停、旧别名和同块撤权已验证；真实 MCP 服务、长会话、多供应商与网络异常尚未完成验收，在线数据仍仅 Sol。
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

## 第三阶段：动态能力与上下文（2026-11-05）

- 动态启停同步模型函数目录和 Python 命名空间，保留 Python 变量；保存的旧函数别名仍经宿主检查，不能绕过禁用。
- codemode 内部函数可在会话启动后注册、同名替换 schema 和实现，模型仍只声明 execute；旧代理参数不符合新 schema 时拒绝。
- 同一个执行块中暂停后撤销 write，恢复后旧执行快照不能越权写入。
- 发现通用原生工具裁剪会整笔删除 execute 源码与结果。现暂时从候选集合排除 execute，并在执行裁剪时保护其调用和结果 ID（包括旧检查点显式请求），普通查询工具仍正常裁剪。
- 此保护刻意保留完整输出，可能增加上下文占用，不等于完成精细输出裁剪；后续需单独设计安全输出裁剪，不能删除 Python 变量和副作用来源。
- 本地 HTTP 模型夹具经过真实 SDK compact 主摘要及分段摘要请求，压缩后保持 Python sentinel 并继续读取已写文件；请求不出现孤儿工具结果。摘要内容由夹具提供，不代表真实模型摘要质量或长会话可靠性。
- 抽出 native-fixture.ts，避免动态测试继续扩大单一测试文件；未修改生产 Runtime。

验证：隔离运行 native-codeact-context（7 项）、native-codeact-candidate 和 tests/harness/prune，共 7 文件 58 项通过；隔离 tsc --noEmit 通过。本轮无线上调用、无浏览器或桌面启动，不切正式。

## 第四阶段：正式源码迁移（2026-11-05）

用户授权验证完成后更新正式，不需要再次确认方向。正式入口统一使用 session.ts 中的原生 CodeAct；删除 native-candidate.ts、stream.ts、events.ts 及旧截流专用测试，新的原生异常测试覆盖对应风险。

新增并通过：
- Codex SSE 真实适配器配合合成网络流：completed、incomplete、failed、提前断流、多调用，5 项；仅正常单调用写入一次，并保留 usage 和 function_call_output。
- 压缩后重开丢失 Python 状态的提示与不重放写入。
- 修复旧文本历史被摘要隐藏后绕过协议校验：同时检查持久化分支与模型投影。
- 正式 GUI 宿主及本地 stdio MCP 16 项，覆盖四种 exposure、服务开关、共享资源、动态刷新、重载、分支恢复。
- execute 不出现在内部函数选择器，预设与“仅 Python”保留固定入口；恢复 codeact_functions 选择记录，避免重开意外重新启用已关闭函数。
- 进程批次、审批暂停继续、记忆写入、数据解析与外部读取业务迁移为原生调用；恢复会话预热。
- 原生确认的无头浏览器 desktop/phone 两项通过（使用已安装 Chromium headless shell 1243；默认 Playwright 1248 未安装，没有安装依赖或弹出 GUI）。
- 正式 GUI 宿主主回归 104/104 通过。旧夹具迁移过程中发现并修正：工具直调协议、裁剪预期、15 分钟缓存默认值、审批临时目录豁免、配置覆盖路径及 .pimoon 项目目录。没有放宽生产审批。
- 26 文件 174 项定向原生/审批/记忆/进程/GUI投影/MCP/裁剪测试通过，PDF 经 execute 回填图片另 1 项通过；隔离 tsc 通过。批处理遥测与外部文件测试单独运行通过，避免跨测试同目录日志混计。

扩大检查曾有 58 个失败，不能隐藏该轮结果；与迁移相关的 GUI 主生命周期已在 104 项复测中全部通过。其余工作台/LSP和配置测试中已有旧路径/旧默认值断言，不把未复测的全目录检查宣称通过。未运行全量 E2E。

支持范围仍为 Windows 桌面；在线模型效果证据仅 Sol，其他供应商不宣称已经线上验证。精细输出裁剪暂不开放，保留 execute 完整事务是明确的保守取舍。

## 成品与更新状态

- 正式源码提交 `c1c15b6`，通过 git archive 导出干净快照，只读借用依赖并复制原生执行器资源；没有打包工作区其他未提交报告/Runtime 改动。
- 干净快照隔离 tsc 与 5 文件 63 项原生/MCP/权限恢复测试通过，Windows desktop --dir 构建及便携封装成功。
- 成品用 ELECTRON_RUN_AS_NODE + PI_SUBAGENT_CHILD 启动 backend.mjs，无窗口。合成 OAuth 与预加载网络转发只用于隔离烟测，经过真实 Codex 请求边界（含 zstd 请求解压）、两次 SSE 响应、Python 写入及结果回填；两次请求都只声明 execute，文件内容 once。
- 初次用本地 completions 地址被成品 Codex-only 网络边界拒绝，这是预期安全限制；之后使用精确 Codex URL 的合成网络夹具验证成功。API key 会覆盖订阅认证，烟测改用隔离合成 OAuth，无真实凭据或网络请求。
- 成品后端、main/preload、Python 与 Rust 资源哈希与干净构建一致。产物登记在 `dist/pimoon-native-update/release.json`，源码版本 c1c15b6。
- 当前旧版 pimoon 仍在运行，未强杀、未覆盖正在使用的目录。根目录 `启动 pimoon.cmd` 下次启动先运行更新器：有 pimoon.exe 进程则拒绝；退出后校验后端哈希，旧目录重命名保留，再将新目录换到 dist/pimoon；失败尝试恢复旧目录。
- 已有 dist/pimoon-next 未覆盖，使用独立 pimoon-native-update。更新器“运行中拒绝、退出后替换、缺件拒绝、哈希不符拒绝”4 项通过，桌面子代理源码测试另 1 项通过。
- 尚未声称运行中应用已升级：需退出所有 pimoon 窗口后，从根目录启动脚本再次启动；原文本会话需新建才能执行。直接点旧 exe 不会触发更新器。
