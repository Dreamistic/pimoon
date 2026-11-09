# AI 审批

Windows 桌面使用独立 AI 分类器，默认 `openai-codex/gpt-6.1-sol`，走现有 Codex OAuth 订阅，不切换主模型，不另索取 API Key。模型不可用时不回退到其他模型。

## 执行链路

常规本地开发先由宿主作有限免审分流，命中时不调用审批模型、不弹框；其余实际工具调用进入 AI，包括不明文件操作、进程、网页与扩展工具。`execute` 只编排内部调用，不重复审批整段代码；Python 本地计算不额外调用模型。

- `allow`：只继续当前操作，不生成持久或会话许可。
- `deny`：结束本次操作，不提供覆盖硬阻断的按钮。
- `ask`：AI 提出具体问题，GUI 显示真实操作、执行本次/拒绝选择和讨论入口。选择绑定原调用，批准后从暂停处继续，不重放此前副作用。

讨论不是授权；即使讨论后 AI 返回 allow，也仍等待明确点击。用户离开不自动代答。取消、配置变化、会话/分支变化、参数变化均使待执行判断失效。无交互界面时 ask 不执行。模型超时、配置错误和无效 JSON 均不执行，区别于用户拒绝。只有真正需要人选择时才发送审批通知。

同会话审批串行；不同会话独立。旧正则/Bash AST 策略、工具默认放行表、deny/ask 路径规则、持久授权存储及经验匹配均已删除。没有恢复旧规则库或历史批准匹配；免审层只识别有限常规操作，不负责拒绝未知操作。

## 常规本地开发免审

`routine` 默认 true，模块设置中的“常规本地开发免审”可关闭，关闭后恢复逐项 AI 判断，不等于关闭审批。

| 类别 | 直接执行范围 | 仍交给 AI |
| --- | --- | --- |
| 读取、列目录、搜索 | 当前工作区普通路径；现有映射中当前项目和 user 的记忆正文/只读索引 | 项目外其他数据、凭据名、`.private`、Git 内部、越界链接或硬链接 |
| 新建与修改 | 常见源码/文档格式；新文件、Git 已跟踪文件、本用户轮次成功新建的文件 | 既有未跟踪文件覆盖、依赖、流水线、包清单、运行控制/安全目录、未知文件类型 |
| Git 查询 | 受限参数的 status/diff/log/show/rev-parse/ls-files | push、提交、重置、任意 -c/-C、env 覆盖、--output、外部 diff、任意对象路径与未知参数 |
| 类型检查 | 已安装 Node 直接调用 `node_modules/typescript/bin/tsc --noEmit`，可加 `--pretty false` | npm scripts、--build、任意 --project 或 Node 注入参数 |
| 单元测试 | 已安装 Node 直接调用 `node_modules/vitest/vitest.mjs run`，可带工作区内 `.test.*` 目标 | watch/UI、自定义命令行配置、项目外目标、未知 CLI 参数 |
| 构建 | 已安装 Node 直接调用 `node_modules/vite/bin/vite.js build`，没有自定义 vite.config，默认 dist 路径未越界 | 仓库自定义构建脚本、npm 生命周期、任意 --outDir/--config、preview/dev server、发布 |

测试与构建要求传入替换环境：PIMOON_HOME、HOME、USERPROFILE、APPDATA、LOCALAPPDATA 全部在调用 cwd 的 `.tmp/tests` 内，TEMP/TMP 如提供也必须在其中。标准 `subprocess.run(env=...)` 本身就是替换继承环境，无需非标准参数。只允许这些目录变量以及 CI/NO_COLOR/FORCE_COLOR；不复用真实用户认证目录。

Git 免审在真正执行时固定系统安装程序，并强制 `--no-pager --no-optional-locks -c core.fsmonitor=false`；diff/log/show 再加 `--no-ext-diff --no-textconv`。类型检查固定 Node 并关闭 incremental/composite 输出，避免 tsconfig 的 tsBuildInfoFile 旁路写入。绑定仅限当前参数、单次消费，参数变化即失效。

免审读取/搜索还在文件系统执行层过滤发现的敏感子项与越界目标，不能仅因请求根目录普通就读出 `.private` 或 `.env.*`。原有 blocked_path、忽略、版本保护继续生效；根目录搜索可能比 AI 审查后的搜索范围窄。敏感内容如确有任务需要，应显式指定目标进入 AI 流程，不通过换接口绕过工具本身的限制。

**信任边界**：这不是完整语义安全证明。普通源码不逐份送模型判断内容是否符合任务；项目代码、测试及已安装依赖作为本地开发工作流的信任基础。Vitest 会执行测试及项目配置，隔离 home 不等于 OS 沙箱，无法阻止代码主动使用绝对路径或网络。处理不可信仓库时应关闭 routine 或使用真正的隔离执行环境。显式任务边界仍约束主模型；不要把免审解释成任意修改授权。不会自动提交/推送，也不生成持续许可。

未跟踪既有文件不自动覆盖，避免把普通扩展名当作可丢弃数据；本轮新文件集合在新用户轮次、会话切换和分支变化时清空。无法确认目标或程序时退回 AI，不自动升级成人工弹框。

## 策略与输入

`src/harness/approval/classifier-prompt.ts` 基于第三方收集的 [auto-mode-classifier](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-code/prompts/auto-mode-classifier.md) 重写，保留威胁模型、授权证据、复合/间接效果分析、硬边界与软风险区分；适配 pimoon 三态决策、结构化输入和人类选择协议，不是整份上游提示词的逐字副本，也不宣称是 Anthropic 完整产品实现。

模型得到：

- 当前实际参数（写入正文、编辑删除/新增内容、进程 argv），而不只是摘要；环境覆盖值省略。
- 当前分支的用户/助手可见文本、工具调用与结果；用户边界及前置提案优先保留，总预算 96000 字符。思考与认证对象不发送。
- 当前 CodeAct 内最近 16 个已结束内部动作的有界参数/结果，区分工具内容与宿主事实。
- Git 调用的实时 status、remote（明确目标目录，仓库可见性未知）；参数指向工作区内脚本或 package.json 的有界正文与哈希。不会递归扫描外部目录或凭据。
- 本次人工讨论。历史批准只作为带 actor 的记录，不能生成权限。

截断保留首尾并显式标记。文件/网页/工具返回内容不作为用户授权，宿主观察也不等于许可。脚本快照只证明采集时内容，不固定稍后执行内容；子进程仍使用宿主权限。

**范围**：本次替换应用审批策略，不取消操作系统权限、CodeAct 的已实现能力边界、凭据/运行中控制面的工具访问保护、文件版本及网络地址完整性检查。AI 不能授予工具本身不存在的能力；审批不是 OS 沙箱，也不能保证模型永不误判。

隐私：参数、相关正文、对话及工具结果会发送给所选审批模型。省略环境覆盖值不等于所有文本已脱敏；原始参数和文件仍可能含秘密。不落盘探针凭据，不将审批意见写成长期授权。

## 配置与迁移

新配置：`PIMOON_HOME/agent/configs/approval-ai.jsonc`；覆盖环境变量 `PIMOON_APPROVAL_AI_CONFIG`。

```json
{"enabled":true,"routine":true,"model":"openai-codex/gpt-6.1-sol","timeout_ms":60000}
```

旧 `approval-gate.jsonc`、`PI_APPROVAL_GATE_CONFIG`、旧授权与经验文件不再读取、不自动迁移、不删除用户原文件。新配置默认启用 AI；原先关闭审批的用户如仍要关闭，需在新配置明确设 `enabled:false`。模型配置在模块设置中可见。

免审写入 `phase=routine` 与类别、耗时；不作为 AI 或人工批准记录。诊断沿用后台 JSONL：模型、输入条数、决定、耗时、actor、请求散列和工具 ID，不复制命令、提示词或正文。会话内审计关联调用 ID，AI 判断不冒充用户决定。

## 验证

定向测试覆盖真实 SDK/CodeAct 暂停与接续、单次批准、拒绝无副作用、取消、失效、讨论、独立多会话及实际 GUI 选择协议。非审批测试默认禁用辅助模型，防止意外联网；审批测试显式配置隔离模型。

`node scripts/probe-approval-ai.mjs --live` 使用只读 Codex OAuth 凭据和隔离目录调用实际分类器，不执行合成动作、不刷新或保存真实凭据。2026-11-09 的 12 场景 x 2 轮全部符合预期，耗时约 4.5–8.3 秒/次；仅证明这些样例，不证明普遍安全。原始合成结果见 [approval-ai.json](../../benchmarks/approval-ai.json)。场景包含普通读写/本地提交、禁止推送、脏工作区重置、明确删除授权、数据外传、工具注入、脚本间接外传、外部脚本、明确生产操作与审批系统源码开发。

免审操作无需辅助模型请求，其余操作仍有独立分类的延迟和订阅消耗；没有以缓存旧许可换取速度。正式版交付另按桌面快捷方式及成品验收核对。`scripts/smoke-approval-ai-artifact.mjs` 使用本地合成服务验证打包后的 allow/deny/无界面 ask，不调用真实订阅；加 `--routine` 验证成品普通读写与 Git 查询不调用分类器，其他三态流程保持有效。


### 常规免审回归

2026-11-09：类型检查通过；定向源码/SDK/宿主/文件系统测试 237 通过、7 个平台条件跳过。真实 SDK 覆盖普通读写与 Git 查询零辅助请求、未知进程仍询问人、根目录搜索过滤敏感子项、tsconfig 增量输出不写入，以及隔离 Vitest 和默认 Vite 的实际执行。不把旧历史的候选比例当作正式免审率，也不执行 Terra/fast 付费对测。
