# 统一进程编排与桌面构建重排

## 决定与接口

用户要求避免向模型暴露相似工具，让模型自己表达依赖关系。本轮沿用唯一原生 `execute` 和 Python `parallel`，没有新增 process_batch、spawn/await、任务句柄或图 DSL。普通 Python、循环和条件仍按顺序执行；只有显式入组的操作并发，不猜测外部状态依赖。

```python
# 普通代码仍串行；下面两个检查须互不依赖，且不争用输出目录、端口或锁。
checks = parallel([
    (subprocess.run, {"args": typecheck_command, "capture_output": True, "text": True, "check": True}),
    (subprocess.run, {"args": independent_tests, "capture_output": True, "text": True, "check": True}),
])
# 全组成功才执行后继。依赖编译产物的测试不能放进编译所在组。
subprocess.run(package_command, capture_output=True, text=True, check=True)
```

- 同组可混合现有 read/find/grep/ls 与受控 subprocess.run。单组仍最多 256 项；读取不新增固定并发上限，进程每组最多两项（包括审批等待）。不同会话不共享这两个槽位。
- 串行和并行共用参数准备、标准 CompletedProcess 转换、UTF-8 捕获、env 完整替换、cwd、超时、授权及取消通路。kwargs 形状、进程选项和 JSON 快照先检查；实际工具 schema、路径及审批仍在各项宿主调用时校验，不承诺所有潜在业务错误都能预检。
- check=False 保留非零退出码；check=True 的非零退出在宿主立即判为失败，不能等整组回到 Python 才影响队列。超时、启动失败也是真失败。collect 返回逐项结果；raise 返回 ParallelError.results 并阻止后继。已启动项排空，未启动项跳过；不重试、不回滚已有副作用。
- 取消回收活动进程树，不启动排队项；整个执行取消仍丢失 Python 状态。单项超时不重启解释器。没有跨 execute 后台任务。
- 每项照常经过 SDK 权限和审批，不因入组批量授权。实际进程副作用独立性仍由模型负责，调度器不承诺锁或文件冲突检测。
- 原内联并发界面复用实际调度轨迹，显示 subprocess.run 与程序名，不额外复制 argv/env。保留“约省”估算；审批等待和资源竞争会影响它，不能替代串行对照。

## 构建

桌面目录构建把 GUI、资源收集及四个独立入口编译放进同一显式阶段组；全部成功后才复制 GUI、生成应用清单并进入封装。失败使用 allSettled 排空在途阶段，然后才能清理 GUI staging，避免边写边删。

- `bun scripts/build.mjs desktop --dir`：默认阶段并发。
- 加 `--serial`：同一实现按顺序执行，用于对照。
- 加 `--output dist/<新目录>`：只允许 desktop --dir，原子创建新目录，拒绝覆盖已有目录；父目录需存在。未指定时沿用既有 dist/desktop 行为。
- BUILD_STAGE/BUILD_TOTAL 给出阶段和总墙钟。便携封装仍依赖整个应用目录构建成功；没有把验证、提交、封装、正式入口切换乱序并发。

本轮不并发三个应用目标，不改 Windows 以外支持范围，不安装或重建 node_modules。

## 本机实测（2026-11-06）

配置根 PIMOON_HOME/HOME/USERPROFILE/APPDATA/LOCALAPPDATA 均隔离到 .tmp/tests。顺序跑各个测量，不让两个 A/B 样本相互争抢。

### 桌面目录构建

同一功能源码、每次全新输出目录，先 S1/P1，再 S2/P2/P3/S3：

| 样本 | 总墙钟 ms | GUI ms | 资源 ms | 后端 ms |
| --- | ---: | ---: | ---: | ---: |
| S1 | 110619 | 67100 | 17889 | 25052 |
| P1 | 17644 | 3837 | 17306 | 623 |
| S2 | 14207 | 3345 | 10019 | 422 |
| P2 | 12947 | 3966 | 12620 | 699 |
| P3 | 12828 | 3756 | 12502 | 665 |
| S3 | 14296 | 3488 | 9921 | 457 |

首轮存在巨大缓存/预热差异，不能把 110.6→17.6 秒当作并发收益。后四个热样本中位数：串行 14.252 秒，并发 12.888 秒，约减少 9.6%。资源阶段因争抢从约 10 秒升至约 12.6 秒，收益明显小于简单相加预测。六次输出各 1031 个文件，文件集合与逐文件 SHA-256 完全一致。此为目录构建，不含便携封装、成品验收或模型生成；小样本不保证其他机器同幅提速。

### 真实进程工作负载

在受控 Rust/Python Runtime 内运行本项目 tsc --noEmit 与三个互不依赖的定向测试文件（process-batch-sdk、explicit-parallel-sdk、scheduling）。使用同一个 subprocess.run，分别普通列表推导与 parallel；子进程各自隔离配置目录。

按 S/P/P/S 实测 11294 / 8640 / 8977 / 10768 ms；全部成功，进程组峰值 2。两项各两次中位数 11.031→8.809 秒，约减少 20.1%。这是固定真实任务的执行块 A/B，不是自然模型采样、完整聊天或账单收益证明；运行时及 SDK 集成分别验证。

## 验证与交付边界

- Node 定向 103 项通过：构建排空/输出保护、只读并发回归、direct/rust 混合读取与进程、两槽队列、collect/raise、部分失败只计一次、状态保留、禁用/旧别名、取消及真实子孙进程回收、损坏结果不重放。
- Vitest 8 文件 73 项通过：真实 SDK 进程并发与逐项审批拒绝、文件权限、结果/备注分离、调度投影、界面渲染、超时预算和工具目录。
- TypeScript --noEmit 通过。未运行会弹窗的测试，也未新增全量 E2E；本次界面只有元数据投影变化，已有组件/投影测试覆盖。
- 收尾回归曾发现两项旧模拟进程结果缺少 schema 必需的 duration_ms；补齐 fixture，新增损坏结果明确失败且不重放的断言后全部通过，没有放宽真实执行器契约。

验证命令：

```text
node --test tests/pimoon/build-tasks.test.mjs tests/pimoon/explicit-parallel.test.mjs tests/pimoon/explicit-parallel-lifecycle.test.mjs tests/pimoon/process-orchestration.test.mjs tests/pimoon/runtime.test.mjs tests/pimoon/function-availability.test.mjs
node node_modules/vitest/vitest.mjs run tests/pimoon/process-batch-sdk.test.ts tests/pimoon/scheduling.test.ts tests/pimoon/scheduling-sdk.test.ts tests/pimoon/codeact-catalog.test.ts tests/pimoon/explicit-parallel-sdk.test.ts tests/pimoon/process-budget.test.ts tests/gui/frontend/features/chat/tools/codeact-ui.test.ts tests/gui/host/projection/progress-payloads.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

本轮交付源码与本地验证；未切换桌面快捷方式、未覆盖正式目录、未推送。当前已运行的正式会话不会自动获得进程入组能力。自然模型使用率及正式成品交付需另外验收。
