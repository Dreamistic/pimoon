# 文本 CodeAct 与自动反馈

## 设计依据

只读对照 `Agent` 的 `StreamCodeDetector`、`CodeActExecutor` 和提示词，并抽样最近 100 个会话文件：发现 182 个执行块，其中 175 个 Python、64 个 Python 块包含循环。没有执行历史代码，没有把会话正文或参数带入仓库。

值得迁入的是持久变量、项目/库函数、数据驱动的分支与循环、按需反馈，而不是把一次原生工具调用换成另一个包装。pimoon 原本就没有五次宿主调用上限；旧集成测试已有单块十次调用。本次新增单块八次读取、四次修改的完整流程验证。

## 模型边界

```text
API text stream
-> incremental CodeAct parser
-> internal codemode event
-> existing approval/execution pipeline
-> persistent Python + host functions
-> execute_result text / original images
```

桌面在 `createGuiRuntime` 包装 SDK 的流函数，不修改只读依赖。模型 API 不接收原生工具声明、function call 或 tool-result 角色；SDK 内仍保留内部事件，供审批、取消、GUI、持久化与统计使用。原始文本分块、message id/phase 及终态补齐的推理签名单独保留，重放时不拆成重复 ID 的消息。旧会话仅在 API 边界转为文本，不改写原会话文件。错误、取消及超限消息中的调用标为 `execute_not_run`。

模型写一个 Python 块，标记独占未缩进的一行：

```text
先说明目的。
<execute>
from statistics import mean
rows=batch("read", [{"path":p} for p in paths])
valid=[r for r in rows if r["ok"]]
if len(valid)==len(paths):
    update_selected(valid)
{"read":len(valid),"mean":mean(scores)}
</execute>
```

`paths`、`scores` 与 `update_selected` 须先定义；示例说明数据流，不是可直接运行的业务脚本。可导入已安装库和工作区模块，工作区模块查找排在运行时、标准库及已安装库之后；不会自动安装依赖。直接网络、进程和 FFI 仍受运行时限制，对应操作走已启用的宿主函数。

解析器跨任意分片处理 CRLF 和 Unicode，忽略 Markdown 围栏及文本 thinking 中的示例。标记不支持属性；结束标记在 Python 多行字符串中也保留，遇到该需求应拆分字符串。闭合后丢弃后缀，不把尚未看到工具结果的臆测写入历史；源码上限为 1 Mi 字符。

**本版不提前执行。** 闭合时可发出内部调用事件，但等待供应商正常终态才执行，以保留真实用量、推理签名及取消/输出超限的语义。不会像参考 Agent 一样立即断流；提前调度仍须单独验证持久提交点、断流终态、用量归属与禁止重放。

## 无 print 反馈规则

选择规则是确定性的，不让另一个模型替程序猜测“最重要”的值：

1. 未赋值的调用表达式返回非 `None` 时自动采集，包含控制流中的调用，但不改写函数或类内部实现；每个调用只执行一次。
2. 非末尾结果最多展示八个短预览，每项最多 600 字符；嵌套结构只检查有限层级和少量条目，不遍历整个大对象或调用用户对象的 `repr`。
3. 末尾顶层表达式仍按原规则完整展示，受统一输出上限约束。赋值的中间对象不自动展示，函数内部结果由返回值传给外层表达式。
4. `_results` 保留最近至多八个完整隐式结果；新结果出现时才替换上一块的集合，可在下一块读取。需要长期复用的数据应存入命名变量。`_` 保留最近的完整结果。
5. 全部赋值而没有输出的宿主调用给紧凑调用计数；异常、部分工具失败始终报告，后项失败仍反馈前项结果。已完成写入不回滚，不自动重放。
6. 显式 `print` 保持原文，不再次自动展示其 `None` 返回值。最后表达式的文件正文不做二次预览，图片仍由宿主转发原始内容块。

因此可以直接写：

```python
send(text="first")
send(text="second")
```

两次调用各执行一次，前项给预览、末项完整展示，不需要 `print(send(...))`。`send` 只是合成测试函数名，不是新增的默认工具。

循环比重复拼接调用更节省源码；分支、聚合和函数则减少等待模型下一次请求的依赖步骤。独立读取通过 `batch` 并发，依赖前项的写入串行检查状态。不要用 Python 线程并发调用宿主桥。

## 预算与验证

现有边界仍在：单块默认 45 秒，单批最多 256 个任务、并发最多 16，批处理只支持同一种只读工具；代码块内混合操作可使用普通 Python 控制流。模型每轮请求预算仍为 20。总输出约 40k 字符，保留输出最多 1 Mi 字符；这些不是“五个调用”的限制。

本地 o200k_base 合成估算（不含共同宿主目录，不代表供应商计费）：入口声明/协议与指导语从 322 降至 297 token；两次短调用的旧原生参数与 print 包装约 20 token，新文本块约 16；十二次循环调用的源码只省约一个 print 包装 token。不能据此宣称整轮费用或耗时降低相同比例；自动反馈相对原先静默执行也会增加必要的输出，主要收益应来自 Python 内筛选、复用和减少模型往返。

验证入口：`tests/pimoon/codeact-parser.test.ts`、`codeact-stream.test.ts`、`text-codeact.test.ts` 与 `runtime.test.mjs`。用本地固定响应服务完成真实 SDK、Python/Rust 和文件读写，不请求付费模型、不启动桌面窗口。
