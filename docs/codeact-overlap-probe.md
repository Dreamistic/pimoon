# CodeAct 闭合执行与终态接收重叠实验

2026-11-05。仅新增实验脚本和故障测试，未修改生产协议、审批或执行时机。

## 方法

`node scripts/probe-codeact-overlap.mjs --live`

Sol / low / SSE，三个交错成对回合，共六次请求。使用生产 CodeActParser 和实际 Python Runtime；模型源码必须与固定合成白名单逐字匹配才执行。输入是隔离目录内 10000 个整数，输出为新建 summary.json，校验 count=10000、total=49995000。

- serial：正常终态成功后执行。
- overlap：第一个完整闭合块立即执行，同时继续接收旧响应；二者均结束才返回。
- 第一回合短任务；后两回合额外 sleep(2)，仅为可控负载，不代表真实工具延迟。
- 每条请求 60 秒上限，无重试。源码凭据只读、不刷新、不落盘。所有测试配置和文件隔离。

## 完整采样结果

结果目录 `.tmp/tests/codeact-overlap/run-Ldm593/`，manifest 源凭据校验未改变。

| 回合 | 模式 | 人工延迟 | 闭合时间 | 流结束时间 | 代码执行耗时 | 总耗时 | usage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | serial | 0s | 5.31s | 59.83s，取消 | 未执行 | 59.83s | 缺失 |
| 1 | overlap | 0s | 8.80s | 10.84s | 0.017s | 10.84s | 749 |
| 2 | overlap | 2s | 6.66s | 9.14s | 2.010s | 9.14s | 749 |
| 2 | serial | 2s | 6.82s | 9.32s | 2.008s | 11.32s | 764 |
| 3 | serial | 2s | 7.52s | 11.11s | 2.010s | 13.12s | 769 |
| 3 | overlap | 2s | 6.87s | 59.86s，取消 | 2.016s | 59.86s | 缺失 |

计时起点为开始收集流，60 秒预算还包含 Runtime 就绪阶段，因此表内取消略早于 60 秒。完整运行退出码为 1，表示出现请求失败，不能报告全部成功。

5 次启动的 Python 均仅执行一次并正确生成结果。第 3 回合 overlap 在 8.88 秒已完成写入，随后等到超时仍未拿到 usage；“文件已写入”和“模型响应被取消”同时成立。原因可能在服务端或传输层，本实验未定位。

此前两次尝试因实验脚本等待 Runtime 子进程退出时，close() 主动 unref 导致 Node 未完成顶层 await 而提前退出，分别留下 3、4 次有效请求记录；不并入上表。修正为 close 后对 child ref 再等待退出，生产 Runtime 未改动。总共实际消耗 13 次模型请求，而非只有最终六次。

## 判断

- 并行隐藏的等待最多约为 min(代码执行耗时, 闭合到终态耗时)，不是全部终态等待。正常完成的 overlap 样本按同一请求串行反事实估算分别节省约 17ms、2010ms；这不是不同请求间可直接比较的实测提速比。
- 并行不能保证收到账单。闭合后响应仍可能长期不结束；直接移除生产截流可能大幅降低可靠性。
- 闭合即提交会允许写入先于后续 error/length/aborted，现有“失败终态不执行”语义不再成立。故障测试明确展示该代价，而非把它藏成通过条件。
- 保留生产现状，不将该实验作为新默认。优先验证供应商原生执行边界，或明确设计提交记录、禁止自动重放、独立结算截止时间后，再讨论纯文本并行执行。不要仅增大 250ms 常量或叠加提示词就宣称解决。
- 本实验不是完整桌面会话；无真实审批、持久化恢复、多轮结果回填或真实工具耗时对测。不能据此证明生产接入安全。

## 验证

`node scripts/test-isolated.mjs node_modules/vitest/vitest.mjs run tests/pimoon/codeact-overlap-probe.test.ts tests/pimoon/codeact-stream.test.ts tests/pimoon/codeact-usage.test.ts tests/pimoon/codeact-stop.test.ts`

4 文件 34 测试通过。覆盖跨片闭合、第二块不执行、未闭合、晚到失败、用户取消、执行错误不重试和 usage 接收。

`node scripts/test-isolated.mjs node_modules/typescript/bin/tsc --noEmit`

通过。实验脚本通过 Node 语法检查；没有运行 GUI 或全量 E2E。
