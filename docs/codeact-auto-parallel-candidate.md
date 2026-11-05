# CodeAct 自动并行候选

后续决策：用户已授权以接口简化为优先，成熟调度进入正式收敛，见 [统一执行接口](codeact-unified-execution.md)。本文保留当轮实验状态和原始数据，不代表最新交付状态。

2026-11-05。状态：隔离分支 `feat/codeact-auto-parallel`，基于 `22de721`；默认关闭，未合并主分支、未构建或替换桌面成品。主工作区既有未提交改动未纳入本候选。

后续自然代码扩展、完整会话 A/B 和暂不上线结论见 [自然任务报告](codeact-scheduling-live.md)。下文记录首轮候选与原始固定源码采样。

## 首轮已实现的边界

模型仍写普通 Python，不需要 batch 或并发数。候选通过 Runtime 内部 `autoParallel: true` 开启；不是模型参数，也不保存到用户配置。

```python
a = read(path="a.ts")
b = ls(path="src")
c = grep(query="TODO")
print(a, b, c)
```

- 只分析顶层连续的单名称赋值。工具限于 read/find/grep/ls，可混合；所有参数必须是字面量关键字参数，目标名称不重复、不覆盖工具名。
- 编译阶段标记候选组；执行时检查名称仍指向本次绑定的宿主代理，否则执行原始语句。统一调度器限流 6，每组最多 64 项，更长序列分组执行。
- 变量参数、表达式、位置参数、别名、循环、条件、try、函数体及普通裸调用均保守串行，不跨过任何其他语句。最后表达式由既有结果赋值机制处理，可能与前项合并。
- 权限、参数校验、审批、超时与取消继续经过原宿主调用边界。禁止自动调度写入、进程及网络工具；不开放 Python 的直接进程或网络权限。
- 保留原始值、赋值顺序、源码异常行号、跨轮状态与编译缓存；图片按源码顺序返回，不按完成顺序错配。
- `schedule_start/end` 与子调用的 schedule_id/index 用于内部关联，不包含路径或文件正文。未启动项不会伪报为已经执行的工具失败。

源码：`src/pimoon/auto_parallel.py` 分析、`scheduler.mjs` 调度；worker/runtime 只负责绑定与桥接。桌面资源复制列表已加入候选模块，但默认不启用。

## 不能隐瞒的语义变化

**并行读取不是完全等同于逐行串行。** 前项读取被拒绝或失败时，同组已经派发的后项只读调用可能已完成，也可能已形成宿主观测/审计记录。失败后停止派发剩余项，排空已发起调用；Python 不给失败语句和后续语句赋值，不执行后续写入，不重放已完成操作。

结构化工具原有“失败仍返回结构化值”语义不变，失败同时进入 tool_failures；不擅自改为抛异常。取消/超时中止在途宿主调用，丢失当前 Python 状态，重建不自动重放。

因此目前不能宣传为“任意 Python 保持精确串行语义的透明并行”。涉及外部变化的多次读取，也不保证同一快照。

## A/B 方法

A：原执行路径，autoParallel=false。B：候选路径，autoParallel=true。两组使用完全相同的 Python 源码、六份本地文本文件及相同摘要输出，不提示模型使用并行 API。

实际链路：确定性原生 execute 响应 → Agent SDK → Rust 监督器 → 持久 Python → 正式文件工具 executeRead → 正式文件系统/观测层。不是假 read 替代业务工具。

每个实验会话先执行一次，再在同一会话重复同一源码，分别记为首执行和热执行；后者命中编译缓存。首执行的 host_ms 可能包含尚未完成的运行时预热等待，不是纯读取时间。统计不包含模型生成与网络耗时。

两种条件：本地读取不加延迟；在真实读取适配器前每次加 20ms 可控延迟。后者只用于验证等待重叠，不代表真实磁盘、远程文件系统或供应商性能。

每个条件 9 轮，AB/BA 交错；每组每轮执行首/热各一次。共 72 次执行，全部业务成功、输出完全一致（Python output_chars 均为 51），A 峰值并发 1、B 为 6。丢弃每个条件第 0 轮后，每个表格单元有 8 个样本。以下为 host_ms 中位数；降幅按两组中位数计算，不做小样本显著性或账单推断。

| 条件 | 阶段 | A 串行 ms | B 自动并行 ms | 耗时下降 |
|---|---|---:|---:|---:|
| 无额外延迟 | 首执行 | 249.45 | 232.12 | 6.9% |
| 无额外延迟 | 热执行 | 36.43 | 14.40 | 60.5% |
| 每次读取额外 20ms | 首执行 | 412.33 | 253.76 | 38.5% |
| 每次读取额外 20ms | 热执行 | 210.68 | 35.72 | 83.0% |

首执行编译时间合并条件后的中位数：A 0.47ms、B 1.53ms；热执行命中缓存。原始样本：`docs/reference/benchmarks/codeact-auto-parallel.csv`。可重复采样测试：`tests/pimoon/auto-parallel-ab.test.ts`，每次结果写到隔离的 `.tmp/tests/auto-parallel-ab/results.json`，不覆盖仓库内的历史样本。

结论：这一类独立读取的热执行收益明确；首执行容易被预热成本掩盖。不能外推为整个对话加速 60%，不能据此声称节省 token；这次未调用付费真实模型，也未测供应商账单。

## 验证

所有测试把 PIMOON_HOME/HOME/USERPROFILE/APPDATA/LOCALAPPDATA 指向候选 worktree 的 `.tmp/tests` 独立目录。未运行弹窗测试，未改依赖。

- Node 定向 62/62：auto-parallel、auto-parallel-lifecycle、runtime、function-availability。覆盖 direct/Rust、限流、依赖/副作用屏障、代理覆盖、权限撤销、错误行号、失败排空、取消/超时及重建、图片顺序、结构化失败、分组上限和原执行器行为。
- Vitest：原生上下文 9/9、既有 batch 业务集成 1/1、A/B 1/1（内含 72 次真实执行）。
- TypeScript `tsc --noEmit` 通过；`git diff --check` 通过。
- 中途发现并修正：Rust 扩展路径下，候选模块必须在严格文件审计安装前加载；未启动作业不应计入工具失败；并发图片不能按完成顺序回传。
- 最初把多套集成测试共用一个隔离 HOME，导致原 batch 测试遥测累计计数失败；分开目录独立复跑后通过。A/B 最终样本单独执行，不与其他套件并行抢占。

复跑时先设置上述隔离目录，再执行：

```text
node --test tests/pimoon/auto-parallel.test.mjs tests/pimoon/auto-parallel-lifecycle.test.mjs tests/pimoon/runtime.test.mjs tests/pimoon/function-availability.test.mjs
node node_modules/vitest/vitest.mjs run tests/pimoon/auto-parallel-ab.test.ts
node node_modules/vitest/vitest.mjs run tests/pimoon/native-codeact-context.test.ts
node node_modules/vitest/vitest.mjs run tests/pimoon/batch-tools.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

各套件使用不同隔离目录；遥测断言套件不要与 A/B 共用 HOME。

## 上线闸门与后续

本轮完成的是窄边界候选和运行时 A/B，不是最终接口收敛上线。默认仍关闭，现有 batch 声明、提示词及行为未删除，避免让正式模型失去当前可用能力。

首轮上线前待办：真实模型自然生成任务的候选命中率与完整会话 A/B（包含变量路径、裸调用、依赖链）；评估失败时提前读取的可接受范围；与主工作区并发开发改动做集成验证。真实 A/B 后续已经完成两轮，覆盖不足且未证明整轮提速，因此仍不切默认，详见自然任务报告。通过后再统一删除模型侧 batch/并发编排说明、切换默认路径，验收打包成品；不覆盖运行中的应用。
