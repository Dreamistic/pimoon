# pimoon

**Dream 的个人桌面 CodeAct 应用。** 月亮标识、月紫配色，基于 o-pi / Pi SDK 源码重新构建，使用独立应用身份与数据目录。

## 启动

双击 **`启动 pimoon.cmd`**，或运行 `dist/pimoon/pimoon.exe`。移动应用时请移动整个 `dist/pimoon` 文件夹，不要只复制 EXE。本机需要可通过 PATH 启动的 Python 3.12+；Node/Bun 不用于运行成品。

- 主模型固定 `openai-codex/gpt-6-astra`，仅走 Codex 订阅端点；不自动换模型。
- **桌面模型使用自建文本 CodeAct 协议，不依赖 API 原生 tool calling。** 模型在独立行的 `<execute>` 与行首 `</execute>` 之间写 Python，结束标签后的内容丢弃；宿主函数目录仍从真实 schema 生成，但不再向模型 API 发送原生工具声明。不再注册 `codemode` 工具：执行块在轮次边界直接运行，结果使用自定义消息持久化；内部函数保留审批、取消和界面展示。完整块闭合会触发本地停止序列，中止当前生成并等待取消收尾后执行；用户取消、缺少完整结束标记或已知输出超限时不启动代码。截流缺少完整用量时界面会明确标注，费用不按零计算。参见 [协议与自动反馈](docs/codeact-protocol.md)。
- 不必用 `print(tool(...))`：未赋值调用的非 `None` 结果自动给有界预览，最多保留八项完整值到 `_results`，直到下一个产生值的代码块替换它。代码块最后一个顶层表达式完整展示，最近的完整结果保留在 `_`。赋值的中间结果不自动输出；静默宿主调用给计数摘要，失败始终报告。字符串保留原文，列表与字典显示为 JSON，图片不重复输出 Base64。
- 普通 `print` 不再自动缩成预览；大结果可用 `observe(value, fields=[...], limit=8)` 主动筛选。仍保留统一输出上限和截断提示。宿主返回的图片内容块随 CodeAct 父结果原样转交，不转换为 Python 字符串。
- 文件分析直接使用持久 Python 与已安装的库，支持直接导入项目函数；不自动安装依赖，不通过 `bash` 再启动 Python。用循环、条件、推导式和函数根据结果选择后续操作，而不只是把工具调用排成直线；独立读取和无共享写入的独立进程任务用 `batch()`；进程默认 2、最多 4 并发，依赖链与重复测速仍串行。普通文件允许跨工作区读取，`native_read` 和只读宿主函数也不再受工作区范围限制；Python 写入与文件修改工具仍限当前工作区。pimoon 登录凭据及常见用户凭据目录保持禁止直接访问，宿主文件工具另有自身路径策略。这不是任意隐私文件的读取授权，也不是强安全沙箱。
- 同一会话保留 Python 变量和导入；新会话隔离。关闭应用、取消执行、会话淘汰后不会恢复 Python 内存，文件写入不会回滚。
- 默认工作区是 `%APPDATA%/pimoon/workspace`。可在左侧选择可信项目；建议先用副本。
- CodeAct 固定启用，不再是可勾选工具。函数面板控制文件、进程、HTTP、搜索等 I/O 权限；全部关闭仍能执行纯 Python。新配置默认提供 `process_run`、`http`、文件与网页函数。启动时将全局旧默认列表中的 `bash` 一次性替换为 `process_run`，移除废弃的 `codemode` 及其配置；不补开其他权限。已保存的会话权限不改写，旧会话需在函数面板启用“进程”或选择 Vanilla 预设；旧原生工具历史不兼容，请新建会话。
- Git、构建和测试使用 `process_run(argv=[...], cwd=..., env={...})`，不拼 Shell 字符串；Windows npm/Gradle Wrapper 映射为 Node/Java 入口，不需要外层 PowerShell 或 Git Bash。默认失败抛异常，取消及超时回收活动进程树；进程超时按代码块剩余预算预留清理时间，正常的命令超时不清空 Python 状态。原始 GET、测速和下载用 `http(...)` 替代 curl；搜索、网页提取用 `websearch(...)`、`webfetch(...)`。外部程序仍使用宿主权限，Python 的直接进程、网络和 FFI 保持受限，**不是强安全沙箱**。参见[函数环境与限制](docs/reference/codeact/README.md)。
- **JEV 未接入本桌面版本，不会向它发送聊天。** Discord 状态同步默认关闭。

## 数据与访问凭据

默认根目录 `%APPDATA%/pimoon`；可用 `PIMOON_HOME` 覆盖。

| 目录 | 内容 |
| --- | --- |
| `agent/` | pimoon 自己的配置、访问凭据和会话 |
| `desktop/` | 窗口状态与 Electron 缓存 |
| `telemetry/` | 本地执行及 SDK 遥测 |
| `logs/` | 桌面诊断 |
| `workspace/` | 默认工作区 |

会话文件含聊天正文，请按私人资料保管。新增执行遥测只记录关联 ID、哈希、大小、用量、时序、错误状态和输出完整性，不记录提示词、代码正文或请求头；不声称覆盖任意 Python 内部行为。

本试用构建使用有效访问凭据副本，**不复制刷新令牌、不刷新原登录**。过期后先在原版自行正常登录，再运行 `python scripts/sync-pimoon-access.py --replace` 同步副本。同步器不会输出凭据，也不会改原文件。桌面内重新登录暂不在此构建的验证范围。

生成不含正文的使用摘要：`python -X utf8 -B scripts/pimoon-report.py`。

逐轮复盘（模型请求、CodeAct、内部工具、批次及状态恢复）：`python -X utf8 -B scripts/pimoon-report.py --timeline --format markdown`。可加 `--session <会话ID>`、`--agent <轮次ID>` 或 `--run <应用运行ID>` 筛选；默认输出 JSON。报告会合并工具事实，包含项目路径，不包含提示词、代码或文件正文，请按私人资料保管。新增关联信息从更新后的运行开始采集，旧记录不猜测补全。

遥测触顶、缺少结束事件、检查点不一致会明确标出；运行中的日志与异常退出可能无法区分。执行成功或一轮结束不代表任务完成、测试通过或用户确认。GUI 的 CodeAct 执行量包含内部调用，搜索采用分析仍只使用模型直接调用，避免把脚本结果当成模型曝光。

## 构建与验证

当前交付范围是 Windows x64 未签名目录版，不是安装器；其他平台、TUI/Web 分支未验收。

```powershell
python -X utf8 -B scripts/build-pimoon-runtime.py
bun scripts/build.mjs desktop --dir
node scripts/build-pimoon-portable.mjs

node scripts/test-isolated.mjs node_modules/typescript/bin/tsc --noEmit
node scripts/test-isolated.mjs --test tests/pimoon/runtime.test.mjs
node scripts/test-isolated.mjs node_modules/vitest/vitest.mjs run tests/pimoon/boundary.test.ts
node tests/desktop/pimoon-smoke.mjs          # 隐藏窗口、零模型请求
node tests/desktop/pimoon-smoke.mjs --model  # 合成真实订阅调用，消耗额度
```

应用运行中不要覆盖其目录。可先构建 `bun scripts/build.mjs desktop --dir`，再运行 `node scripts/build-pimoon-portable.mjs --output dist/pimoon-next` 生成独立新版；保存并退出旧应用后，运行 `dist/pimoon-next/pimoon.exe`。原启动脚本仍指向 `dist/pimoon`；要继续使用该脚本，请退出所有版本后重新执行默认封装命令。仅修改源码或新建会话不会更新已加载的桌面后端。

原生构建使用已有 Rust 工具链，可设置 `PIMOON_RUST_BIN`。目录封装复用本机 Electron 运行时，可设置 `PIMOON_ELECTRON_DIST`；不修改来源目录。开发依赖目前为本机上游依赖目录的 junction，勿在该 junction 中安装或升级；独立安装依赖时请使用新目录。

测试记录位于 `.tmp/tests/pimoon-desktop/`，测试凭据位于受限 `.private/pimoon-smoke/`。详细结果、已知限制和早期失败见 [VALIDATION.md](VALIDATION.md)。保留的上游文档可能仍描述旧配置路径，以本页为准。

## 来源与许可

应用改版与维护：**Dream**。保留 [AGPL-3.0-only 许可证](LICENSE)及上游、第三方版权说明，见 [NOTICE.md](NOTICE.md)。此目录同时提供本次修改的完整应用源码；分发时须保留相应许可证与对应源码。
