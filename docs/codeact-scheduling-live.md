# CodeAct 自动调度：自然代码与完整会话 A/B

后续决策：用户已授权以接口简化为优先，成熟调度进入正式收敛，见 [统一执行接口](codeact-unified-execution.md)。本文保留当轮实验状态和原始数据，不代表最新交付状态。

2026-11-05，Windows、Codex 订阅 Sol / low / SSE。仍在隔离候选分支，默认关闭，不合并 main、不更新运行中桌面。

## 决策

**继续保留实验，不切默认。** 自动调度在简单独立读取中有效，但自然任务覆盖不足，完整会话没有可重复的提速证据。不为了提高命中率要求模型改写成指定赋值/推导式，也不把任意循环、Path 对象、属性访问或带副作用的表达式强行改成并行。

当前候选新增：顶层简单 list/dict 推导式，运行时只接受精确内置 list/tuple 的 2..256 个精确 str 项；只允许直接只读函数、字面量参数、循环变量、纯字符串拼接或无转换/格式指令的 f-string。字典键必须为原循环变量。一次最多派发 6，分组最多 64；其余原样回退。native_read 与正式只读工具进入同一调度器，保留原路径保护、4MiB 限额、UTF-8 校验及读取计数。

## 从真实代码发现的问题

首个双组探针均完成业务，但候选根本没命中。A 使用显式 batch；移除 batch 说明的 B 自行生成 ThreadPoolExecutor + native_read。共享 Python 桥接只有一套发送/接收管道，多线程调用存在回包错配/串帧风险；当次成功不能证明安全或算成自动调度收益。

已加执行线程归属检查：所有桥接及 native_read 在发送任何帧之前拒绝其他线程调用，报错引导普通同步调用；测试确认拒绝后协议仍可继续。候选实验提示词删掉 batch 说明，改为一句同步调用契约；并发度不交给模型。此提示词替换仅存在实验 bundle，不改变正式模型说明。

首轮保护后窄版的六个会话中有三个 fetch failed、usage 不完整。其他三个完成，但仍无自动调度命中。这些失败保留在原始表，不作为成功对测样本，也不把传输故障归因于调度器。根据实际代码里的 `{p: native_read(p) for p in paths}` 扩展上述推导式边界。

## 真实 A/B 设计

`scripts/bench-codeact-scheduling.mjs`：显式 --live、只读来源目录、不刷新、不落盘凭据，经 stdin 传给子进程；每个会话独立 PIMOON_HOME/HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP。三批试验的源凭据内容校验均未改变。模型只访问合成任务，不加载用户上下文文件。

A：当前提示词与串行运行时。B：移除模型 batch 说明、同步调用契约与自动调度。线程安全检查为两组共用。实验构建严格确认 Runtime 开关与提示词替换均实际命中；不依赖隐式环境开关，不修改正式 source default。

三个自然任务，两轮 AB/BA 交错，每组 6 会话：

- independent-review：读取六份服务说明，筛选结果写入 review.json，源文件必须逐字不变。
- locate-edit：先定位运费实现，仅修改门槛，再读取验证；用于观察有依赖链时是否保持串行。
- conditional-edit：检查八份配置、精确修改四份、回读验证、输出 changed.json；保留观测版本与写入屏障。

任务不规定 Python 结构、是否并行或工具批次。每个完整会话有文件系统断言，记录端到端耗时、根 execute 区间并集、请求/usage、自动调度事件、原生读取计数。最多 12 次请求、180 秒会话期限、不自动重试。来源凭据有效期不足十分钟即拒绝，不刷新。

## 扩展版的两轮结果

12/12 业务成功；A 28/28、B 25/25 模型响应 usage 完整。B 没有使用显式 batch；6 个会话中 2 个命中，共 5 组、40 次读取（32 次原文读取、8 次正式 read）。有依赖的定位修改没有错误地合并。

| 自然任务 | A 会话中位数 s | B 会话中位数 s | B 命中会话 |
|---|---:|---:|---:|
| independent-review | 24.38 | 24.69 | 0/2 |
| locate-edit | 21.92 | 26.77 | 0/2 |
| conditional-edit | 44.91 | 48.00 | 2/2 |

混合场景会话中位数 A 24.86s、B 31.70s；不能宣称端到端变快，也不能据此断言总体必然变慢：每场景每组仅两个样本，模型代码与服务端时延变化很大。根工具耗时中位数 A 271.35ms、B 274.36ms，占各会话耗时的中位比例约 1%；当前真正的大头不是本地读取。

供应商 total tokens 合计 A 58,576、B 46,609；这是完整 usage 的实际计数，不是可见文本估算。但任务实现、请求数、提示词都不同，且缓存/推理因素不同，不能外推为账单节省或调度器因果收益。没有把两个模型随机程序的差异当作“同源执行提速”。

所有 20 个真实会话样本（首探针 2、保护后窄版 6、扩展版 12）均保留在 `docs/reference/benchmarks/codeact-scheduling-live.csv`，区分 cohort，不混合计算成功率或性能。未提交原始凭据、用户配置、完整会话或临时目录。

## 同源自然程序重放

将扩展版首轮 B 的 conditional-edit 实际生成的四段 Python 固化为合成测试 fixture，不要求模型重写，再由确定性原生响应通过真实 SDK、Python/Rust、正式文件工具执行。三个 AB/BA 交错轮次，共 6 次业务回放，均通过。

两条路径的四段执行状态完全一致 `[成功, 成功, 失败, 成功]`，最终文件断言通过、均有 17 次 native_read；那个中间失败是 raw read 没有建立 edit 观测版本，随后正式 read 后恢复，不能为了改善数字绕过写入安全边界。

四段 host_ms 累计中位数 A 512.54ms、B 493.49ms，下降约 3.7%；仅三个样本且首轮含冷启动差异，不能证明稳定优势。关键结论是自然代码确有覆盖、错误恢复和最终写入没有改变，而不是只验证手写理想代码。

测试：`tests/pimoon/auto-parallel-natural-replay.test.ts`；源码 fixture：`tests/fixtures/codeact-scheduling-natural.json`；样本：`docs/reference/benchmarks/codeact-scheduling-replay.csv`。

## 验证与交付范围

- Node 定向 80/80：原执行器、可用函数、自动调度与生命周期；含原文计数、Unicode、重复键、失败无半赋值、签名错误保留 TypeError、自定义迭代/字符串回退、线程拒绝和协议可继续。
- Vitest：确定性六文件 A/B 1/1（72 次执行）；原生上下文 9/9；原 batch 集成 1/1；自然代码重放 1/1（6 次完整程序）。
- `tsc --noEmit`、`git diff --check` 通过。未运行有窗口测试，未改写依赖。
- 真实采样后补了非法 native_read 签名回退保护，已用定向测试和同源自然程序验证；真实 A/B 源码哈希仍留在隔离 manifest，未伪称不同修订逐字一致。
- worktree 的类型检查依赖只读 node_modules 链接：源码里已有显式相对 node_modules 导入，不能仅靠 Node 向父目录寻找包。缺链接时会出现无关 TS2307，恢复只读链接后通过。忽略规则同时覆盖 node_modules 目录与符号链接，借用依赖不入库。

正式批次接口和提示词尚未删除；本轮不把候选视为交付替换，不强推上线。下一阶段应先解决常见普通循环/输出形态的安全覆盖，保持模型无需选择编排方式；但不以扩展复杂 AST 规则掩盖不足 1% 工具耗时的现实。完整会话提效还需单独量化模型往返成本，超出这轮自动读取调度的改动范围。

复跑需只读可用订阅和桌面资源目录，显式命令：

```text
node scripts/bench-codeact-scheduling.mjs --live --source-home=PATH --resources=PATH --runs=2
node node_modules/vitest/vitest.mjs run tests/pimoon/auto-parallel-natural-replay.test.ts
```

所有运行先设置隔离 HOME 等目录；不要让不同遥测断言套件共用目录。默认模型 Sol/low/SSE，仅代表本次 Windows 分支的小样本，不能外推其他供应商。
