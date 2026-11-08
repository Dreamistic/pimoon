# pimoon 0.1.0 本机验证

## Claude Code 风格记忆（2026-11-08）

- 统一为 `user / feedback / project / reference` 与 `metadata.type`，明确各类保存时机、原因/适用条件、查重和使用前验证；不引入额外总结模型或专用 CRUD 工具。
- 自动上下文共享 200 行 / 25 KiB UTF-8 上限，预算包含目录、格式及失效通知，只注入索引。保留 pimoon 的自动索引和 user/project 范围，不让模型手工维护派生索引。
- 当前范围的旧顶层 type 在扫描时先备份再升级；旧 lesson 合入 reference，不假定它是用户反馈。保留正文、名称、日期、状态和未知字段。复用提交队列，拒绝冲突元数据和备份冲突；关闭自动记忆不触发自动迁移。
- 隔离验证：全项目 TypeScript 检查通过；记忆、SDK 会话、系统提示和审批相关 14 个测试文件，283 项通过、2 项跳过。覆盖四类格式、CRLF 原文保留、重复/并发迁移、备份冲突、预算溢出、按需读取、关闭与管理操作。
- 测试使用独立 `.tmp/tests` 配置根，没有迁移真实用户记忆、启动可见窗口或调用付费模型。此处记录源码验证，不代表正式桌面入口已更新。

## 公开源码准备（2026-11-06）

- 重写 README、安装与构建指南，明确 Windows x64 支持范围、工具链、目录部署、Python 运行时要求、自有账号认证与未验收的登录续期。
- 固定当前已验证的直接依赖版本，声明构建直接使用的 Photon、QuickJS 和 electron-winstaller；生成并保留 Bun 锁文件（解析摘要为 1045 packages）。删除 Rust / Electron 的本机路径回退，默认使用 PATH 工具链及安装依赖中的 Electron。
- 桌面封装只将 electron.exe 改名，保留其他 EXE 和许可证，拒绝覆盖已有成品与源目录重叠；凭据同步必须显式指定来源，默认桌面烟测不再读真实登录，付费模式需单独配置来源。
- 通过：TypeScript 类型检查；Rust 测试 1 项与 release 编译；Python / Rust 运行时测试 36 项；模型请求边界测试 18 项；目录封装测试 1 项（合法 PE 夹具，只验证资源封装、不启动 Electron）；脚本语法与同步器帮助检查。
- 已有只读借用依赖环境下，`bun scripts/build.mjs desktop --dir --output .tmp/tests/public-source-app` 成功。没有覆盖正式桌面目录、修改快捷方式或启动窗口，没有调用付费模型。
- 全新安装验证未完成：独立测试目录中的在线依赖解析 / 下载多次超时。离线锁文件生成成功，但离线安装仍缺 Mermaid 与 MathJax 字体包；独立 Electron 下载也超时。不能把锁文件解析成功、已有依赖构建或 PE 夹具测试当作完整从零编译 / 成品启动验收。
- 当前跟踪文件与完整 Git 对象（2403 个历史 blob）扫描未发现匹配的真实密钥、JWT、私钥或私人认证文件；公开文件中的已知用户名与本机开发目录已清理。模式扫描不是绝对无泄漏证明。
- 历史提交仍包含私人作者邮箱及旧版文档 / 脚本中的本机路径，且已存在远端；普通后续提交无法删除这些历史信息。未重写历史或强推，不能声称整个 Git 历史已匿名化。新提交使用公开 noreply 身份。

2026-11-03，Windows x64。

## 纯 CodeAct 函数环境（2026-11-04）

- 删除 `codemode` 注册与原生工具历史兼容。源码元数据在轮次边界直接执行，结果保存为 `codeact_result`；函数权限按分支独立记录，关闭 I/O 不关闭 Python。桌面子代理使用相同执行系统。
- `process_run` 用 argv/cwd/env 替代外层 Shell，Windows npm/Gradle Wrapper 映射为 Node/Java；默认失败抛异常，支持取消、超时、有界输出与活动进程树回收。`http` 复用代理、安全 DNS、重定向与审批，覆盖 GET 文本、测速与原子下载；不提供虚构的 DNS/TLS 指标。
- 工作树隔离验证通过：TypeScript 类型检查；48 个定向 Vitest 文件，738 项通过、4 项跳过；36 项真实 Python/Rust 执行器测试。验证使用 `scripts/test-isolated.mjs`，用户目录及 TEMP/TMP 均指向独立 `.tmp/tests` 目录。
- 覆盖十二次混合读写、动态函数开关和跨轮状态、原生模型工具响应拒绝、审批与受保护路径、实际 npm CLI/JVM 合成 Wrapper、进程树取消、本地 HTTP/代理、下载与网络限制、GUI 元数据/图片/diff 恢复及无界面子代理。没有执行真实 Android 编译或生成 APK，没有启动桌面窗口，没有调用付费模型。
- 桌面目录构建和独立 `dist/pimoon-codeact` 封装通过；不覆盖 `dist/pimoon`，需用户退出旧版本并自行启动新目录。旧原生工具会话需新建；旧默认函数不自动迁移，可应用 Vanilla 预设并保存。
- 另外通过 19 项真实 GUIHost/MCP 函数集成用例与 7 项配置默认值用例。扩大检查时，旧 GUI 宿主综合套件有 31 项失败，其中大量模拟模型依赖原生工具声明和旧 Shell/工具模式，其他失败尚未逐项归因；这些旧夹具尚未整体迁移，不作为新版全量验收通过。用户要求先试用后，停止继续扩大测试范围。
- 本次不改依赖。已有未提交的遥测与执行器草稿保留，不夹带进任务提交；工作树验证与独立暂存快照验证分开记录。独立导出暂存内容、排除已有草稿后，TypeScript 类型检查及 9 个关键流程测试文件的 27 项测试通过。

## CodeAct 本地停止序列（2026-11-04）

- 对照 Agent 的闭合后截流逻辑，并检查当前 Codex Responses SDK：请求类型与构造器没有原生 `stop` 字段。本次不向订阅端点注入未知参数，而是在完整行首结束标记出现后主动取消当前模型流。
- 独立取消信号不会取消整个 agent；源流收尾后，原 SDK 工具管线只执行一次，再带结果进入下一次请求。已有终态不重复中断；用户取消优先，未闭合、已知失败/超限、正文不一致或取消收尾超过五秒均不启动代码。
- 未收到正常终态的响应不重放不完整的 response id、文本签名/phase 和推理条目。用量保留为已报告数值，`codeactStop.usage` 与遥测 `usage_status` 区分完整、部分和缺失；界面费用显示 `—` 并提示统计不完整，报告单列截流次数与不完整用量，不把缺失当成零费用。
- 独立导出暂存快照、排除旧性能草稿后验证通过：23 个定向 Vitest 文件、177 项测试；32 项 Python/Rust 执行器测试；8 项 Python 报告测试；全项目 TypeScript 类型检查。真实 Codex SDK 的内存 SSE 测试覆盖没有正常终态时取消读取、同批次完整终态/用量、输出超限、单次执行及继续下一轮；另覆盖父级取消竞争、收尾超时、历史签名过滤和 GUI 统计提示。
- 桌面构建及 `dist/pimoon`、`dist/pimoon-codeact` 封装通过；两份后端与费用统计提示对应的前端产物均匹配本次构建。封装前检查无运行中的 pimoon 进程；未自动启动程序，需重启后加载新行为。
- 这些是离线 SDK/执行链路验证，不是实际订阅请求、计费节省或服务器停止推理的证明。没有启动桌面窗口或调用付费模型；所有测试用户目录均隔离到 `.tmp/tests`，没有改依赖或真实配置。原有性能草稿继续留在工作树，不夹带提交。

## CodeAct 结束标签同行后缀误报（2026-11-04）

- 只读检查实际失败消息，确认行首已有完整结束标签，但同行附带文字。旧解析器要求结束标签独占整行，因此把标签和后缀误算入 Python，最终报未闭合；当时尚未启动代码，未检查 Discord 图片服务或 Host 配置。
- 改为识别行首的完整 `</execute>` 即闭合；提交偏移精确到标签末尾，同一行后缀、换行及后续分片均不进入源码或重放文本。开始标签仍独占一行，真正缺失、缩进或损坏的结束标签不自动补齐；取消、输出超限与供应商终态检查不变。
- 先加入合成复现：修复前 6 项失败、17 项通过；修复后 17 个定向 Vitest 文件、106 项测试与全项目 TypeScript 类型检查通过。覆盖所有双分片切点、逐字符分片、尾随文字/空白、错误结束标记、重放截断、取消/超限，以及真实 SDK/Python 文件流程中标签后的额外修改不执行。没有复制私人会话正文到测试。
- 桌面构建及 `dist/pimoon`、`dist/pimoon-codeact` 封装通过；两份后端逐字节匹配本次桌面构建，包含修正后的协议。封装前检查没有运行中的 pimoon 进程；未自动启动窗口或调用付费模型，仍需用户重启后重试原请求。
- 测试的 PIMOON_HOME、HOME、USERPROFILE、APPDATA、LOCALAPPDATA 与 TEMP/TMP 均隔离到 `.tmp/tests`。未修改真实会话、配置或凭据；原有未提交性能草稿不纳入本次提交。

## 桌面文本 CodeAct 与无 print 反馈（2026-11-04）

- 只读参考 Agent 的流式检测器、执行器、提示词及 100 个会话文件；未执行历史代码，未保存私人正文和参数。设计及预算见 [文本 CodeAct 与自动反馈](docs/codeact-protocol.md)。
- 桌面模型 API 不再接收原生工具声明及 tool-call/tool-result；文本块转换为 SDK 内部 `codemode` 事件，继续沿用审批、文件检查、取消与持久化。保留原始文本分块、message id/phase、终态补齐的推理签名及供应商用量；最终正文与流式源码不一致时拒绝执行。
- 自动反馈覆盖未赋值调用（含循环/条件中的调用），每次副作用只执行一次；最多八个短预览，完整值保留在 `_results`，末尾表达式仍完整展示。赋值结果保持静默，无输出的宿主操作给计数；失败和已完成的前项结果仍报告。工作区模块可直接导入，标准库与运行时模块优先。
- 本次暂存内容单独导出到隔离快照，排除原有性能草稿后验证通过：17 个定向 Vitest 文件、98 项测试；32 项真实 Python/Rust 执行器测试；全项目 TypeScript 类型检查。集成测试覆盖一个代码块内八次读取、四次条件修改，导入项目函数和标准库、跨块变量复用、禁用能力及未闭合块不执行。
- 覆盖任意分片、CRLF/Unicode、围栏/thinking 示例、仅终态补齐正文、未请求原生调用、签名补齐、取消、输出超限、正文不一致、自动反馈预算、显式 print 不重复及部分失败不重放。首次混合流程测试发现项目模块不在 Python 搜索路径，已补充路径并重跑通过。
- 完整桌面构建与封装通过：`dist/pimoon/pimoon.exe` 及 `dist/pimoon-codeact/pimoon.exe`。封装前确认没有运行中的 pimoon 进程；原启动脚本现在可启动新版。产物检查确认两份后端相同、新资源与当前源码一致，并用成品执行器完成十二次无 print 调用、模块导入及结果复用。成品采用当前工作树，原有紧凑 JSON/流式计时草稿仍另行保留，未夹带本次提交。
- 本地 token 估算只比较合成源码/协议片段，不是供应商账单或端到端性能结论。未启动桌面窗口，未调用付费模型；真实 Codex 的协议遵循、GUI 重启及费用/耗时对测尚未验证。
- 尚未启用提前执行：闭合块仍等待供应商正式终态；断流、取消及输出超限时不启动代码。既有 45 秒单块、20 次模型请求和 batch 资源预算未取消；不是无限制执行环境。

定向命令（将所有用户目录与 TEMP/TMP 隔离到 `.tmp/tests`）：

```powershell
node node_modules/vitest/vitest.mjs run --no-cache tests/pimoon tests/harness/extensions/system-prompt.test.ts tests/harness/extensions/system-prompt-session.test.ts tests/gui/frontend/features/chat/tools/codemode-ui.test.ts tests/gui/frontend/features/chat/tools/tool-presets-ui.test.tsx
node --test tests/pimoon/runtime.test.mjs
node node_modules/typescript/bin/tsc --noEmit
bun scripts/build.mjs desktop --dir
node scripts/build-pimoon-portable.mjs
```

## 跨工作区访问与独立新版封装（2026-11-04）

- 确认正在运行的 `dist/pimoon` 仍是旧包；源码此前已允许普通文件跨工作区读取，新建会话不会更新已加载的后端。本次未覆盖运行中的目录。
- CodeAct 的 `bash.workdir` 改为普通目录访问检查，允许相对及绝对路径指向其他项目；凭据路径仍拒绝，命令审批不变。Python 与文件修改工具的写入边界不变；shell 命令使用宿主权限，工作目录不是读写沙箱。
- 封装器新增 `--output`，可生成独立新版，拒绝输出目录与 Electron 来源目录重叠。完整构建及封装通过，产物为 `dist/pimoon-next/pimoon.exe`。旧启动脚本仍指向 `dist/pimoon`，需退出旧应用后显式启动新版。
- 当前工作树（包含此前未提交的性能草稿）验证通过：全项目 TypeScript 类型检查；4 个定向 Vitest 文件、15 项测试；30 项真实 Python/Rust 执行器测试。覆盖外部 `read/find/grep/ls`、Python/native_read、外部相对/绝对 shell 工作目录、凭据保护、写入边界与破坏性命令审批。
- 另外比对新版 Python 资源与源码，并使用新版打包资源验证外部读取、外部写入拒绝和凭据拒绝；确认后端包含新工作目录策略。临时产物检查脚本首次因等待已 unref 的子进程退出而返回 13；补充检查脚本的事件循环保活后重跑返回 0。
- 全部测试使用 `.tmp/tests` 下隔离的 PIMOON_HOME、HOME、USERPROFILE、APPDATA、LOCALAPPDATA 与 TEMP/TMP。未启动桌面窗口、未调用付费模型；真实 GUI 重启后的手动验证尚未执行。

定向命令（先隔离上述环境变量）：

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run tests/pimoon/direct-tools.test.ts tests/pimoon/shell-tools.test.ts tests/pimoon/boundary.test.ts tests/pimoon/portable-build.test.ts
node --test tests/pimoon/runtime.test.mjs
bun scripts/build.mjs desktop --dir
node scripts/build-pimoon-portable.mjs --output dist/pimoon-next
```

## CodeAct 唯一执行入口

- 模型请求只声明 `codemode`；文件、进程、网络宿主工具仅供 Python 内部调用。直接工具调用在执行边界被拒绝，嵌套调用仍经过审批、工作区校验、取消与遥测。
- 原有底层工具选择保留为宿主能力开关。旧默认列表、恢复会话及 SDK 变更工具集合时补齐 CodeAct，不额外启用未选择的宿主能力；关闭入口同时关闭这些能力，显式空列表不启用工具。未交付的上游工具不能通过选择器启用。
- 从实际启用工具的参数 schema 生成紧凑函数目录，包含可选参数和嵌套对象；隐藏工具的系统指导语、技能与子代理索引不残留。CodeAct 调用串行执行以保护持久变量，独立读取通过有界 `batch()` 并发。
- 普通文本保留原文，脚本主动筛选；宿主图片内容块随父结果原样返回，不经过 Python 字符串化，不残留到下一次执行。
- 验证通过：14 个 Vitest 文件、75 项测试；22 项真实 Python/Rust 执行器测试；全项目 TypeScript 类型检查。覆盖唯一声明、恶意直调拒绝、跨轮变量、读写与 CRLF、能力关闭、配置迁移、默认保存、会话恢复及分支导航、批次部分失败、审批、图片转交、取消和状态丢失。
- Vitest 收集限定为 `tests/**/*.test.{ts,tsx}`，避免误收 `.tmp` 历史副本和应由 `node --test` 执行的 `.mjs` 套件。第一次按目录运行时曾误收这两类文件；调整后重跑上述套件全部通过。
- 离线 SDK 基准已改为全量经过 CodeAct，100 次操作及 101 次本地固定响应请求成功，包含实际文件修改、批次与同一预热进程复用。原始结果：`.tmp/tests/tool-benchmark/run-57vQvS/results.json`。这是固定响应和热文件系统的功能/耗时检查，不是模型选择能力或端到端优势证明。
- 桌面目录构建及独立便携包封装通过，产物为 `dist/desktop/app`、`dist/pimoon`。没有启动桌面窗口或付费模型，没有修改真实用户配置；正常启动新包时才迁移配置并加载新链路。

定向验证命令（运行测试前将 PIMOON_HOME、HOME、USERPROFILE、APPDATA、LOCALAPPDATA、TEMP/TMP 全部隔离到 `.tmp/tests`）：

```powershell
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run tests/pimoon tests/harness/tool-defaults tests/harness/extensions/system-prompt.test.ts tests/harness/extensions/system-prompt-session.test.ts tests/gui/frontend/features/chat/tools/codemode-ui.test.ts tests/gui/frontend/features/chat/tools/tool-presets-ui.test.tsx
node --test tests/pimoon/runtime.test.mjs
node scripts/bench-pimoon-tools.mjs
bun scripts/build.mjs desktop --dir
node scripts/build-pimoon-portable.mjs
```

## CodeAct 启动预热与异步遥测（历史记录）

- 应用初始化当前工作区会话时后台启动 Python，不执行用户代码、不请求模型。首次工具调用复用预热进程；初始化未完成时仅等待剩余时间。不同会话变量隔离，关闭或回收执行资源时释放进程。
- 两轮离线 SDK 基准：后台初始化约 194–237 ms；预热完成后的首次简单 CodeAct 调用约 2.9 ms，上轮按需启动为 215–367 ms。没有把启动成本消除或从计时中扣掉，而是提前重叠执行。
- 遥测改为有界异步队列，25 ms 合并后后台批量写盘，正常关闭显式排空。入队 CPU 与后台 I/O 独立统计；工具不等待写盘，必要的请求绑定安全校验保留。
- 本组负载入队累计约 26–27 ms；后台 I/O 等待累计约 392–433 ms，不把后者加到工具耗时。工具声明和模型请求次数不变。
- 已通过：371 项定向 Vitest、15 项执行器测试和全项目 TypeScript 类型检查；另 6 项按原有 Windows 条件跳过。覆盖预热复用、无代码执行、重启内存提示、会话隔离、提前关闭、初始化失败、预热中取消、Python 意外退出恢复、并发排空、日志上限与写盘失败。
- 未启动桌面窗口、未访问付费模型，现有 dist/pimoon 尚未包含源码修改。后续已安装官方 Bun 1.4.4（<Bun 安装目录>），经官方 npm SHA-512 校验，构建帮助和 bun run typecheck 验证通过；尚未重新构建桌面包。
- 详情见 [工具执行系统测试与优化](docs/pimoon-tool-execution-audit.md)。

## 首轮工具执行系统专项测试与优化（历史记录）

- 简单文件操作的热调用约 10–30 ms；在隔离 SDK 基准中与 o-pi 同源文件工具处于同一量级。不是安装版 Electron 或真实模型端到端对测。
- 8 个不同文本文件：CodeAct 并发读取约 34–39 ms，顺序读取约 96–97 ms。补齐既有 batch 的简短调用说明，没有新增工具入口或模型回合。
- CodeAct description 估算从 145 降至 140 token；短结果包装从 15 降至 4 token，保留原文、错误和截断提示。遥测复用进程级追加句柄，仍同步提交。
- 修复 GUI 仍按旧规则隐藏直接文件工具的问题；与执行边界共用开放集合。
- 已通过：367 项定向 Vitest、9 项真实 Python/Rust 执行器测试、全项目 TypeScript 类型检查。另 6 项按原有 Windows 条件跳过。修正旧配置目录夹具和取消测试的缓冲写入竞态。
- 本轮未启动桌面窗口、未访问付费模型、未重建桌面包；当前命令环境没有 Bun，现有 dist/pimoon 尚未包含本轮源码修改。
- 方法、数据、限制及复现命令见 [工具执行系统测试与优化](docs/pimoon-tool-execution-audit.md)。

## 首次使用后的核心打磨（历史记录）

- 单次文件操作直接向模型声明；CodeAct 只负责需要编排的任务，不再重复内嵌文件工具的 JSON 参数定义。
- 桌面关闭通用 print 自动预览，保留普通输出、显式 observe 和统一输出截断上限。
- 操作摘要根据实际嵌套调用显示读取、修改、批量操作或工具编排；Python 仅在代码详情标注。优先展示失败子工具的原因。
- 已通过：7 项执行器测试、20 项 SDK 直接调用与界面渲染定向测试、全项目 TypeScript 类型检查、桌面构建。其中 SDK 测试用本地固定响应完成真实 read/edit，确认没有启动 Python；不是付费模型实测。
- 本轮没有启动真实模型烟测或桌面 E2E；现有手动烟测的输出预期已同步，但未重跑。下次正常重启应用后加载新代码。

## 初版验证记录（保留原结论）

已完成：
- TypeScript 全项目类型检查；最终桌面源码构建与独立 pimoon.exe 封装。
- 真实桌面合成烟测：6 次 Codex 请求、3 次 Python 执行，12,454 个已报告 token，未报告用量 0。验证跨轮变量保留、新会话不同 Python PID、大输出预览、文件工具嵌套调用、stderr 和被捕获的 native_read 错误。JEV 调用为 0。
- 6 项真实执行器离线测试通过：持久状态、引用回读、错误保留、截断、取消后保留文件/清空内存、结构化工具失败、帧上限。
- 7 项请求边界与路径测试通过；后补的独立目录断言尚未单独运行，不算已通过测试。
- Rust 执行器重新编译，1 项 Rust 测试通过。
- 隐藏窗口启动检查通过，检查期间模型请求为 0。

真实烟测记录：`.tmp/tests/pimoon-desktop/2026-11-03T12-51-11-018Z-5f54af/`。最终目录隔离和界面修正后重新通过类型检查与构建；没有为这些收尾修改再次进行付费主流程烟测。

保留的问题与边界：
- 初次真实请求失败源于未识别 SDK 的 Zstd 请求压缩，随后修复并完成上述真实烟测；失败记录未删除。
- 早期源码仍有共享 ~/.pi 路径，烟测在旧目录留下 6 个合成遥测文件，旧输入历史有 4 条合成输入命中。最终源码已改为 pimoon 独立配置、历史与遥测路径；旧目录未擅自清理，清单位于 `.tmp/tests/isolation-audit/legacy.json`。
- 不是完整上游回归；没有完成重启恢复场景的真实模型烟测，也没有验证其他平台、安装器、独立 OAuth 登录。相关新增测试入口存在不代表已运行。
- Python 与路径检查不是强沙箱；仅在可信工作区使用。应用未签名，需要本机 Python。访问凭据副本过期需重新同步，不会刷新原登录。
- 不宣称端到端速度或 token 效率优于上游。
