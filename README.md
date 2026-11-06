# pimoon

<img src="assets/icons/icon.svg" width="88" alt="pimoon 月亮标识">

Dream 维护的开源 AI 编程桌面工作台，基于 [o-pi](https://github.com/Orion-zhen/o-pi) 与 [Pi SDK](https://github.com/earendil-works/pi)。以持久 Python CodeAct 为核心，把文件分析、工具调用和进程执行放在同一段可编排代码中。

目前验证范围为 **Windows x64 桌面目录版**。未提供已验收的 macOS / Linux 版本、安装器或公开二进制下载；保留的 TUI / Web 代码不代表交付支持。

## 特性

- **桌面编程工作台**：月紫主题、多会话与项目切换、流式 Markdown、代码高亮、文件预览和差异查看。
- **持久 Python CodeAct**：同一会话复用变量与导入，常用标准库预载；用循环、条件和数据结构处理工具结果，减少机械往返。历史可保存，应用重启不恢复 Python 内存。
- **明确的并发边界**：`parallel()` 编排独立读取，`subprocess.run([...])` 执行显式进程命令；普通循环不自动并发。界面展示执行状态与并发估算节省，不把估算当实测加速。
- **统一 I/O**：文件读写、代码检索、网页搜索与提取、HTTP 下载，以及带取消和超时处理的进程执行。以实际启用的函数目录为准。
- **审批与权限控制**：工具开关、项目可信状态及审批流程，常见凭据目录受保护。外部程序仍以当前用户权限运行，**不是强安全沙箱**，请只操作可信项目。
- **独立数据与执行复盘**：只使用 pimoon 自己的数据目录，提供本地执行遥测、用量与时间线报告；不自动借用原版登录或聊天历史。

默认模型为 `openai-codex/gpt-6-astra`，当前桌面请求边界仅允许 Codex 订阅端点；可用模型和额度取决于自己的账号。不自动更换模型，不内置共享账号、密钥或模型额度。JEV 未接入，Discord 状态同步默认关闭。

## 从源码编译

### 环境

在 Windows 10 / 11 x64 安装并加入 PATH：

| 工具 | 要求 |
| --- | --- |
| Git | 克隆源码 |
| Node.js | 24+，构建脚本与测试使用 |
| Bun | 1.4+（本次验证 1.4.4） |
| Python | 3.12+，确保 `python --version` 可用；成品运行也需要 |
| Rust | stable，包含 Cargo、rustc 与目标平台链接器；推荐 rustup 的 MSVC 工具链及 Visual Studio C++ Build Tools |

首次安装需要联网下载 npm 包及 Electron。不需要原作者的目录、全局 Pi 安装、依赖 junction 或私人配置。

```powershell
git clone https://github.com/Dreamistic/pimoon.git
cd pimoon
bun install --frozen-lockfile
bun run build:desktop
.\dist\pimoon\pimoon.exe
```

构建依次执行 Rust 测试与编译、前后端资源构建、Electron 目录封装。直接依赖固定版本，`bun.lock` 锁定传递依赖。不要删除锁文件再安装 `latest`。

`dist/pimoon` 必须是新目录，封装拒绝覆盖已有成品。再次构建请退出旧应用并移走旧目录，或指定独立输出：

```powershell
python -X utf8 -B scripts/build-pimoon-runtime.py
bun scripts/build.mjs desktop --dir
node scripts/build-pimoon-portable.mjs --output dist/pimoon-next
```

`PIMOON_RUST_BIN` 可指定含 Cargo / rustc 的目录。默认 Electron 来自安装依赖中的 `electron/dist`；也可用 `PIMOON_ELECTRON_DIST` 指定原始 Electron 分发目录（需含 `electron.exe`），不复用其他应用的安装目录。

### 首次运行与认证

首次运行会创建自己的配置和默认工作区。GUI 提供模型服务登录入口，但本项目尚未验收完整的首次登录、续期流程；编译或离线烟测通过不代表账号可调用模型。

已有自己的 Pi Codex 登录时，可显式同步有效访问凭据副本：

```powershell
python -X utf8 -B scripts/sync-pimoon-access.py --source "<自己的 Pi agent 目录>"
```

同步器仅复制有效访问凭据和对应模型服务信息，不复制刷新令牌、不触发刷新、不改原登录。过期后先在原应用正常登录，再加 `--replace` 同步。没有兼容登录时不要使用他人的 `auth.json`；仓库不提供认证文件。使用前需确认账号能够访问所选模型。

### 部署与升级

把整个 `dist/pimoon/` 文件夹复制到目标 Windows x64 电脑，安装 Python 3.12+ 后运行 `pimoon.exe`。成品无需 Node.js、Bun 或 Rust；仓库中的 `启动 pimoon.cmd` 需要 Node.js，是开发辅助入口，不是分发必需文件。目录版未签名，无自动更新。

升级时在独立新目录构建，保留旧目录，正常退出旧应用后再切换快捷方式。不要覆盖运行中的目录；本流程不自动修改桌面快捷方式。

## 数据与隐私

默认根目录 `%APPDATA%/pimoon`，可用 `PIMOON_HOME` 覆盖，不回落到 `~/.pi`。

| 目录 | 内容 |
| --- | --- |
| `agent/` | 配置、访问凭据、会话与记忆 |
| `desktop/` | 窗口状态与 Electron 缓存 |
| `workspace/` | 默认工作区，可另选可信项目 |
| `telemetry/`、`logs/` | 本地执行指标与诊断 |

会话含聊天正文。凭据与这些目录应按私人资料保管，不能提交到 Git。执行遥测以关联 ID、哈希、用量、时序和错误状态为主，不记录提示词、代码正文或请求头；诊断与报告仍可能含项目路径，不要未经检查公开。

```powershell
python -X utf8 -B scripts/pimoon-report.py
python -X utf8 -B scripts/pimoon-report.py --timeline --format markdown
```

仓库忽略运行数据、依赖、构建产物、临时目录和常见密钥文件。公开前还需检查 Git 历史与提交作者信息：删除当前文件不能删除历史中的内容。

## 验证

本次已验证已有依赖环境下的类型检查、Rust 测试与桌面源码构建；全新依赖安装及 Electron 下载因网络超时未完成，尚不能宣称全新电脑端到端构建验收通过。详见 [VALIDATION.md](VALIDATION.md)。

测试数据固定隔离到 `.tmp/tests` 或 `.private`，不使用真实用户配置：

```powershell
node scripts/test-isolated.mjs node_modules/typescript/bin/tsc --noEmit
node scripts/test-isolated.mjs --test tests/pimoon/runtime.test.mjs tests/pimoon/public-build.test.mjs
node scripts/test-isolated.mjs node_modules/vitest/vitest.mjs run tests/pimoon/boundary.test.ts
node scripts/smoke-codeact-artifact.mjs .tmp/tests/public-smoke dist/pimoon
```

最后一项使用本地合成模型服务，无窗口、不读真实凭据、不消耗额度。真实订阅烟测需显式提供自己的凭据来源并主动启用 `--model`，不是常规构建步骤。验证范围与限制见 [VALIDATION.md](VALIDATION.md)。

## 文档与许可

- [安装与故障排查](docs/guides/getting-started.md)
- [构建实现](docs/reference/runtime/build.md)
- [CodeAct 函数环境与限制](docs/reference/codeact/README.md)
- [文档索引](docs/README.md)（部分上游文档尚未适配，以本页交付范围与路径为准）

应用改版与维护：**Dream**。遵循 [AGPL-3.0-only](LICENSE)，保留上游及第三方作者归属，见 [NOTICE.md](NOTICE.md)。分发应用时须按许可证提供对应源码和许可说明。
