# 工具失败反馈与恢复

2026-11-05：根据本地历史中的重复失败修正以下边界；不放松审批或写入版本保护。

- CodeAct 的文件工具前置校验允许普通缺失路径进入下层恢复逻辑，保留 `read` 的相近路径提示和 `find/grep` 的逐范围错误。仍检查原路径、真实父目录、凭据路径与网络路径；悬空链接拒绝放行。进程工作目录与 `native_read` 仍要求路径存在。
- 缺失路径没有更具体建议时，返回主动 `find/ls` 定位提示。不自动猜测目标、不扩大搜索范围。
- Python 正常结束但保留内部失败时，模型输出首行使用 `partial_failure`，聊天卡片显示“执行完成 · 有内部失败”。`isError` 仍表示执行块失败，不把已捕获异常改成整块失败，不自动重放写入。
- `native_read` 描述明确不建立编辑/覆盖所需的版本观测；修改已有文件前使用 `read`。
- `edit` 对整份文件换行一致时的 LF/CRLF 进行适配，然后沿用精确匹配、唯一性、重叠与版本检查。新文本的统一 LF/CRLF 跟随文件风格；混合换行、单独 CR、缩进和其他空白不做模糊转换。BOM 和未编辑内容保留。混合换行文件仅换行不匹配时给出 `newline_drift` 诊断。

## 验证

全部命令将 `PIMOON_HOME`、`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA` 指向 `.tmp/tests/tool-recovery-env/` 下各自的独立目录。

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node node_modules/vitest/vitest.mjs run tests/harness/file-tools tests/pimoon/path-recovery.test.ts tests/pimoon/boundary.test.ts tests/pimoon/read-data.test.ts tests/pimoon/native-codeact-candidate.test.ts tests/gui/frontend/features/chat/tools/codeact-ui.test.ts`：28 文件、411 测试通过，6 项跳过。
- `node --test tests/pimoon/runtime.test.mjs tests/pimoon/process-orchestration.test.mjs`：42 测试通过。

GUI 使用无窗口组件渲染；SDK 流程使用隔离本地合成模型。上述结果不代表真实供应商在线验收，也未替换运行中的桌面成品。
