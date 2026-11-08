# 进程输出编码

受控 `subprocess.run` 保留单一接口，新增可选 `encoding`，不新增工具或 Shell 包装。

- 捕获后分别解码 stdout/stderr。默认严格尝试 UTF-8；Windows 失败后使用 worker 启动时 `locale.getencoding()` 获取的本地 ANSI 代码页。它不受 Python `-X utf8` 覆盖，不写死 GBK。
- 显式 `encoding="gbk"` / `"cp936"` / `"utf-8"` 等覆盖自动判断；也可单独指定 `encoding` 开启文本捕获。字符集沿用宿主 TextDecoder 支持集合及常见 Python/Windows 别名，不承诺支持所有 Python codec。未知显式字符集在该进程启动前拒绝。
- 自动判断只是默认值：本地 ANSI 代码页不一定等于程序使用的 OEM/自定义编码；非 UTF-8 字节也可能恰好构成合法 UTF-8。已知编码应显式指定，不能靠猜测保证正确。
- 默认严格解码，不静默生成替换字符。解码失败保留进程退出事实与捕获的原始字节，不自动重跑。串行抛 `UnicodeError` 子类，含 `stdout`/`stderr`（bytes）、`returncode`、`status`；并发失败码为 `PROCESS_DECODE_ERROR`，失败行 `value` 保留宿主原始结果中的 `stdout_base64`/`stderr_base64`。
- 并发错误策略仍在宿主生效：raise 停止后续派发，已启动项排空；collect 收集所有项。解码失败与非零退出分开，不伪造进程未执行。
- 每条流仍最多捕获 65,536 字节。仅被截断流舍弃不完整的末尾字符，完整流继续严格校验；DEVNULL 流不捕获、不解码。原有截断提示、超时、取消、审批及环境替换语义保留。
- UTF-8 原始 BOM 保留；显式 `utf-8-sig` 去除 BOM。默认不添加 `errors="replace"` 等有损行为。

验证（全部使用 `.tmp/tests` 下隔离的 PIMOON_HOME/HOME/USERPROFILE/APPDATA/LOCALAPPDATA）：

```text
node node_modules/vitest/vitest.mjs run tests/pimoon/process-output.test.ts tests/pimoon/codeact-process.test.ts tests/pimoon/codeact-catalog.test.ts
node --test tests/pimoon/process-orchestration.test.mjs tests/pimoon/runtime.test.mjs
node node_modules/vitest/vitest.mjs run tests/pimoon/process-batch-sdk.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

定向 Vitest 26 项、Node 61 项（进程编排 25 + 通用运行时 36）及类型检查全部通过，包括 direct/Rust 的真实 Windows `taskkill /?` 只读输出、本地代码页检测、GBK 覆盖、原始字节恢复、无重放副作用、DEVNULL、截断边界、超时与解码失败并存、并发停止派发和真实 SDK 审批。没有执行针对用户进程的 taskkill；源码验证阶段未构建或切换成品，后续交付见下文。

## 桌面交付（2026-11-08）

- 源提交 `81cd26eb65244cc5de921af416d96a419ee35229`；tree `2b6f44b362c52dcaf1af9668e024942af0909639`。在固定提交的独立 worktree 构建，成品目录 `dist/pimoon-encoding-81cd26e`，依赖只读借用，未安装或重建。
- 原生源码与上一正式版无变化；复用前校验 Electron 71 个运行时文件及原生执行器，未修改旧目录。这是本机运行时复用，不是全新安装验收。
- 无窗口成品基础烟测、编码专项烟测均通过，各两次本地合成模型请求且只声明 execute：验证自动 UTF-8/GBK 分流、cp936 显式覆盖、真实 `taskkill /?`、解码失败原始字节恢复、Python 状态及副作用仅一次。配置全部隔离至 `.tmp/tests/encoding-release-81cd26e`，没有使用真实模型凭据。
- `release.json` 记录 1105 个文件 SHA-256，快捷方式切换后已逐项复验；后端 SHA-256 `4a3a1a665c826fb93c7430fdccdbad7fd5f72057094c6d8ab1de97a13322fe5d`，原生执行器 SHA-256 `9b92f3698dc96803d73e9e0d4c59fc593f301dc88bfbaabf9c5f06e8a6a3d4fe`，清单 SHA-256 `ded56173fd8711267c0943f43ac1f2669c286e24102a5623ab841ee6f8616919`。
- 重新读取桌面快捷方式目标后备份至 `dist/shortcut-backups/pimoon-before-encoding-81cd26e-20261108-114628.lnk`，切换到新目录的 `pimoon.exe`，切换后再次读取目标并核验。旧目录和运行进程保留，没有强制结束或覆盖当前会话；用户正常退出全部窗口后从桌面快捷方式重开生效。
- 没有启动可见 GUI，后端成品验收不等于可见窗口启动验收；未推送。本文交付记录的后续提交不改变上述成品来源。
