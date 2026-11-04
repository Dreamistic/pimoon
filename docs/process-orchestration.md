# 进程编排与超时隔离

2026-11-04，Windows。只运行合成 Node 进程与本地固定模型服务，不重放用户历史命令，不访问真实网站，不调用订阅模型或启动 GUI。

## 历史问题

只读检查历史代码的 AST 与命令特征后，确认两类情况不同：

- 约 23.84 秒的五条命令属于两组重复网络测速采样（3 次、2 次），不能当作五个独立普通任务自动并发。并发测速会争抢带宽，改变结果；应保持采样语义，原始 HTTP 使用现有 http 函数而不是重复启动 Shell/curl。
- 另一次命令申请 200 秒，但旧版代码块的外层上限只有 45 秒，先触发外层取消并销毁 Python。当前源码的代码块上限已经是 30 分钟、进程默认 300 秒，但连续任务累计接近截止时间时仍可能重现预算倒挂。

不会把所有循环改成并发，也不会自动推断任意程序的读写依赖。

## 本次行为

### 明确独立的进程使用既有 batch

```python
jobs = [
    {"argv": ["git", "status", "--short"], "cwd": "frontend", "timeout": 15},
    {"argv": ["git", "log", "-1", "--oneline"], "cwd": "backend", "timeout": 15},
]
results = batch("process_run", jobs, limit=2)
assert all(item["ok"] for item in results)
```

示例 cwd 需要替换为实际存在的普通目录。进程默认 2、最多 4 并发；文件只读批次仍默认 6、最多 16，每批最多 256 项。结果按输入顺序返回，不按完成顺序乱序。

每项仍走同一个 SDK 参数校验、函数开关、路径检查及审批链，不提供 Shell 包装或直接 Python 子进程通道。一项失败不重试、不重放已完成项，也不停止其他独立项。使用 check=False 时还必须检查 value.status / value.exit_code，不能只看 batch 的 ok。

以下情况继续串行：生产者到消费者、安装到构建、共享状态修改、重复网络速度/延迟采样。默认的单次 process_run 失败仍抛异常，阻止后续依赖步骤；捕获错误或 check=False 是显式选择。

取消后停止派发尚未开始的项，已运行进程按现有进程树回收逻辑取消。Python 仍只有一个串行单元格；并发只发生在宿主进程调用，不使用 Python 线程共享桥接管道。

### 进程超时早于外层截止

每次派发进程前，实际 timeout 取申请值（默认 300 秒）与剩余代码块预算减 5 秒的较小值；余量不足 5 秒则不启动新进程，返回可捕获错误并提示放到下一块。

预留时间用于进程树回收和 Python 接收失败；申请值仍受真实 schema 的最大 1800 秒限制，非法参数不通过裁剪变成合法调用。裁剪事件 process_timeout_capped 只记录 requested_seconds / effective_seconds / remaining_ms 及关联 ID，不保存命令、环境值或正文；复盘摘要用 process_timeout_caps 单列次数。

普通进程超时不再用外层取消替代：当前调用失败，但解释器 PID 和此前变量仍可保留。用户取消、Python 无限循环、外层超时与崩溃仍按原有安全边界处理，可能丢失内存；审批等待或系统清理阻塞耗尽预算时也不能承诺保留状态。已完成的文件写入不回滚。

## 定向验证

- 先复现两个失败：原先 process_run 不允许 batch；进程申请时限超过外层预算时先清空 Python。
- 真实 Python/Rust + Node 验证：默认两并发及四并发上限、结果有序、部分失败不重放、单进程超时后变量/PID 保留、靠近外层截止时优先返回进程错误、取消停止排队并回收活动进程。
- 真实 SDK 集成验证：进程批次保留文本 CodeAct 唯一入口，逐项审批仍能阻止副作用；失败批次不启动依赖项，生产者/消费者保持串行，命令超时后跨块状态仍在。
- 超时裁剪报告保留数字预算，不导出命令与源码。

同一预热 Python 中对五个独立 Node 进程做三轮交错对测，每个进程等待 200 ms：串行中位数 1433 ms，两并发中位数 870 ms，约缩短 39%。这是合成独立等待任务的宿主墙钟，不是历史测速、真实构建或端到端模型延迟的提速保证；没有设置会因系统抖动而失败的耗时断言。

验证结果：排除原有未提交草稿的独立暂存快照中，10 个定向 Vitest 文件、55 项通过；Python/Rust 的 41 项 Node 测试、9 项 Python 报告测试和全项目 TypeScript 类型检查通过。工作树原有草稿保留，不混入本次提交或独立构建。

已从该独立快照构建并封装 `dist/pimoon-process-next/pimoon.exe`，没有覆盖 `dist/pimoon` 或自动启动窗口。后端与构建结果逐字节相同，Python/Rust 资源与快照匹配；成品资源验证了进程批次和超时后变量/PID 保留。该验证使用成品 Python/Rust 资源与已匹配源码控制器，不是完整 GUI 端到端测试。产物验证脚本首次等待已 unref 的子进程退出而返回 13，补充脚本保活后重跑返回 0。

使用前保存并退出旧应用，运行独立新版并新建会话；旧原生工具历史不兼容。原启动脚本仍指向 dist/pimoon，重启旧路径不会加载本次修改。

原始记录保存在 `.tmp/tests/process-orchestration/`，不提交私人会话与原始命令。

复现（目录与凭据全部隔离）：

```powershell
node scripts/test-isolated.mjs --test tests/pimoon/process-orchestration.test.mjs
node scripts/test-isolated.mjs node_modules/vitest/vitest.mjs run tests/pimoon/process-budget.test.ts tests/pimoon/process-batch-sdk.test.ts tests/pimoon/codeact-process.test.ts tests/pimoon/text-codeact.test.ts tests/pimoon/shell-tools.test.ts tests/pimoon/batch-tools.test.ts
node scripts/test-isolated.mjs node_modules/typescript/bin/tsc --noEmit
```
