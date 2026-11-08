# 网页只读并发与单入口恢复

2026-11-08 修复：模型将独立网页检索放入 parallel 时被旧白名单拒绝，随后改用外层原生并发包装又违反单 execute 边界。

- Python 与宿主同步允许当前启用的 websearch、webfetch、http 入组，复用原有工具权限、取消、错误、媒体返回及调度轨迹，不新增第二个模型入口。
- http 仅允许默认 text 或显式 text/probe，不能携带 path；下载仍串行。Python 与宿主均在派发前检查整组，非法后项不会导致前项先执行。
- 明确直接调用一次 execute，并在 Python 内使用 parallel；多原生调用继续全部拒绝，不拆解包装、不自动重放。错误正文提供正确恢复方式。
- SDK 的未声明工具先返回 Tool not found，并可能进入下一次模型反馈；它不经过已注册工具的 beforeToolCall。多个已注册 execute 才由现有整轮校验拒绝。测试分别覆盖，不能混为同一路径。

## 验证

所有测试的 PIMOON_HOME/HOME/USERPROFILE/APPDATA/LOCALAPPDATA 均在 .tmp/tests 下；未启动可见窗口、未读取真实凭据、未安装依赖。

- Node 72 项通过：direct/rust 混合网页读取、顺序、动态禁用/旧代理、失败收集、下载双侧预检；并回归读取与进程并发、取消、超时及 20 MiB 边界。
- Vitest 5 文件 48 项通过：真实 SDK 逐项权限与嵌套调用、多原生调用拒绝、未知外层包装不执行、提示契约和调度投影。网页宿主使用合成夹具，没有声称真实联网或自然模型采样已验收。
- TypeScript --noEmit、git diff --check 通过。

```text
node --test tests/pimoon/explicit-parallel.test.mjs tests/pimoon/explicit-parallel-lifecycle.test.mjs tests/pimoon/process-orchestration.test.mjs
node node_modules/vitest/vitest.mjs run tests/pimoon/codeact-execution-loop.test.ts tests/pimoon/codeact-catalog.test.ts tests/pimoon/native-codeact-candidate.test.ts tests/pimoon/explicit-parallel-sdk.test.ts tests/pimoon/scheduling-sdk.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

本次仅源码修复与本地提交，尚未构建或切换正式桌面版；当前运行会话仍用旧白名单，可先串行调用网页工具。查询桌面快捷方式的 PowerShell 调用被现有进程策略拒绝，未改快捷方式或绕过该策略。
