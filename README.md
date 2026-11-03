# pimoon

**Dream 的个人桌面 CodeAct 应用。** 月亮标识、月紫配色，基于 o-pi / Pi SDK 源码重新构建，使用独立应用身份与数据目录。

## 启动

双击 **`启动 pimoon.cmd`**，或运行 `dist/pimoon/pimoon.exe`。移动应用时请移动整个 `dist/pimoon` 文件夹，不要只复制 EXE。本机需要可通过 PATH 启动的 Python 3.12+；Node/Bun 不用于运行成品。

- 主模型固定 `openai-codex/gpt-6-astra`，仅走 Codex 订阅端点；不自动换模型。
- **CodeAct（工具名 `codemode`）是模型唯一的执行入口。** 文件、进程和网络操作都由持久 Python 编排，如 `print(read(path="README.md"))`；用 `batch()` 并发独立读取，用脚本筛选后再返回结果。模型只收到一个工具声明，启用的宿主函数签名从真实参数 schema 生成；直接调用底层工具会被拒绝。界面按实际嵌套调用显示操作。
- 普通 `print` 不再自动缩成预览；大结果可用 `observe(value, fields=[...], limit=8)` 主动筛选。仍保留统一输出上限和截断提示。宿主返回的图片内容块随 CodeAct 父结果原样转交，不转换为 Python 字符串。
- 文件分析直接使用持久 Python 的 `pathlib`、`json` 等库，不通过 `bash` 再启动 Python。普通文件允许跨工作区读取，`native_read` 和只读宿主函数也不再受工作区范围限制；Python 写入与文件修改工具仍限当前工作区。pimoon 登录凭据及常见用户凭据目录保持禁止直接访问，宿主文件工具另有自身路径策略。这不是任意隐私文件的读取授权，也不是强安全沙箱。
- 同一会话保留 Python 变量和导入；新会话隔离。关闭应用、取消执行、会话淘汰后不会恢复 Python 内存，文件写入不会回滚。
- 默认工作区是 `%APPDATA%/pimoon/workspace`。可在左侧选择可信项目；建议先用副本。
- 默认启用 Python、工作区文件、`bash`、`websearch` 和 `webfetch` 宿主能力。工具面板的底层开关控制 CodeAct 可调用的能力；关闭 CodeAct 会同时关闭这些能力，不回落到直调。旧的默认列表和会话会自动补齐 `codemode`，不额外启用未选择的进程或网络工具；显式空列表仍无工具。保留的上游工具不因此成为已交付能力。
- Git、构建、测试通过 Python 中的 `bash(command="...")` 执行；搜索和网页使用 `websearch(...)`、`webfetch(...)`。Windows 需要已安装 Git Bash；命令使用宿主权限，推送、安装依赖和破坏性操作沿用审批规则。Python 的直接进程与网络调用仍受限，路径与 Python audit 检查**不是强安全沙箱**。
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

node node_modules/typescript/bin/tsc --noEmit
node --test tests/pimoon/runtime.test.mjs
# 设置 PIMOON_HOME 为 .tmp/tests 下的临时目录后：
node node_modules/vitest/vitest.mjs run tests/pimoon/boundary.test.ts
node tests/desktop/pimoon-smoke.mjs          # 隐藏窗口、零模型请求
node tests/desktop/pimoon-smoke.mjs --model  # 合成真实订阅调用，消耗额度
```

原生构建使用已有 Rust 工具链，可设置 `PIMOON_RUST_BIN`。目录封装复用本机 Electron 运行时，可设置 `PIMOON_ELECTRON_DIST`；不修改来源目录。开发依赖目前为本机上游依赖目录的 junction，勿在该 junction 中安装或升级；独立安装依赖时请使用新目录。

测试记录位于 `.tmp/tests/pimoon-desktop/`，测试凭据位于受限 `.private/pimoon-smoke/`。详细结果、已知限制和早期失败见 [VALIDATION.md](VALIDATION.md)。保留的上游文档可能仍描述旧配置路径，以本页为准。

## 来源与许可

应用改版与维护：**Dream**。保留 [AGPL-3.0-only 许可证](LICENSE)及上游、第三方版权说明，见 [NOTICE.md](NOTICE.md)。此目录同时提供本次修改的完整应用源码；分发时须保留相应许可证与对应源码。
