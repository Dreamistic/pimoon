# CodeAct

Windows 桌面与其无界面子代理只向模型声明一个原生 `execute` 工具。其 `code` 参数进入持久 CPython；内部函数目录由启用能力的真实 schema 生成，不再分别声明为模型工具，也不解析正文中的 XML 执行块。

参数为 `code`、`desc` 和可选 `confirm`。GUI 以 desc 为标题，真实状态和结果单独展示；confirm 仅澄清用户意图，不替代内部函数审批。无交互入口不执行需要确认的代码。正常 toolUse 终态后才执行；每轮只允许一个 execute，多个调用全部拒绝，不做客户端截流。旧文本 CodeAct 会话可阅读，但需新建会话才能继续执行，压缩旧历史不绕过此限制。原协议记录见[历史文本协议](../../codeact-protocol.md)。

## Python 与函数

普通数据处理使用标准库或已安装的项目函数，不启动另一个 Python：

```python
from pathlib import Path
import json
rows = [json.loads(line) for line in Path("events.jsonl").read_text(encoding="utf-8").splitlines()]
{"events": len(rows)}
```

`read(...)`、`grep(...)`、`edit(...)`、`webfetch(...)` 等是注入的函数，也可通过 `functions.read(...)` 调用。函数参数使用关键字；目录中的 `?` 表示省略，不是传 `None`。关闭 I/O 函数不关闭 Python。下一块执行前同步函数集合，保留其他变量；旧函数引用不能绕过当前权限。

`read(path=...)` 的文本返回值是带 `<read>`、范围和上下文的展示结果，不是原始文件字符串，不能直接交给 JSON/CSV 解析器。`native_read(path)` 返回不带展示包装的 UTF-8 原文，限普通文件 4 MiB：

```python
invoice = json.loads(native_read("invoice.json"))
```

返回值语义由真实 output schema 进入函数目录。把展示结果当 JSON 解析时保留 `JSONDecodeError` 并附诊断，不自动剥标签、重读或重试；原文中的同名标签、Unicode 和换行不改写。原文读取仍受路径保护，也不替代修改已有文件前的 `read` 版本观测。

普通本地文件读写和下载可以离开工作区；凭据、系统写入和应用安全配置仍受保护，网络及设备路径不能当作普通本地文件直接访问。已有文件通过 read 后的 write/edit 修改并检测版本冲突；原生 Python 只允许新建文件，不直接覆盖已有文件。原生删除、重命名和改权限需转为明确审批的 process_run 操作。这些检查不是强安全沙箱，也不是任意读取隐私文件的授权。

## 审批继续

内部调用需要审批时，运行时暂停原调用并展示卡片，可由独立审批顾问生成说明和建议。用户确认后原调用继续，不重试、不重放此前副作用，也不需要主模型调用 `approval`。拒绝、取消或上下文变化不能通过换入口重试。

本次批准只作用于当前暂停调用；会话和持久范围按运行时展示的规则匹配。意见随原调用结果进入主模型，不自动变成许可。完整语义和限制见[审批](../approval-gate/README.md)。

## 进程与显式 Shell

使用唯一的受控 `subprocess.run`，以参数数组启动程序，不隐式拼接 Shell。PowerShell、pwsh、cmd、bash、sh、curl、wget 等可直接调用，不按程序名封禁：

```python
r = subprocess.run(["powershell", "-NoProfile", "-Command",
                    "Get-Item . | Select-Object -ExpandProperty Name"],
                   capture_output=True, text=True, check=True)
```

- `shell=True`、把整个命令作为 `args` 字符串、`Popen` 仍不支持；Shell 脚本作为显式解释器的参数传入。
- `cwd` 默认工作区；省略 `env` 继承环境，显式 `env` 完整替换子进程环境，不改变父环境。
- Windows npm/npx 入口转换成 Node CLI，Gradle Wrapper 转换成 Java 主类；其他 `.cmd/.bat` 通过显式 `cmd.exe /d /c` 调用。不自动展开 `JAVA_OPTS`、`GRADLE_OPTS` 字符串。
- 默认 `check=False` 保留退出码；`check=True` 非零退出抛 `CalledProcessError`。超时抛 `TimeoutExpired`；`capture_output=True, text=True` 捕获文本并返回 `CompletedProcess`。解码默认严格 UTF-8、Windows 再尝试本地代码页，可用 `encoding` 覆盖；失败保留原始字节，不重放进程。
- 单进程默认 300 秒，上限 1800 秒；实际受代码块剩余预算约束并预留五秒清理。stdout、stderr 各保留 64 KiB，超出明确截断。单进程超时不重建 Python；整块取消、超时或崩溃仍可能丢失状态。
- 串行和 `parallel` 共用执行与审批通路；允许 Shell 不代表免审批，也不自动扩大任何已有授权。外部程序使用宿主权限，并非文件或网络沙箱；curl/wget 不继承 `http` 的代理、大小限制或站点校验。
- 前台进程结束才算完成，无跨块后台任务。取消或超时回收进程树：Windows 使用 `taskkill /T /F`，Unix 使用进程组；不承诺阻止恶意脱离监督的程序。

2026-11-08 移除程序名黑名单。定向验证：`codeact-process.test.ts`、`process-batch-sdk.test.ts`、`codeact-catalog.test.ts`、`process-budget.test.ts` 共 36 项通过、4 项跳过（未安装的可选程序及 Windows 下可能触发 WSL 的入口）；`node --test tests/pimoon/process-orchestration.test.mjs` 25 项通过；`tsc --noEmit` 通过。覆盖 PowerShell 管道、cmd、curl、显式批处理、SDK 串行/并发与审批拒绝，以及进程超时、取消、编码和状态保留回归。配置目录均隔离在 `.tmp/tests`，没有构建或切换桌面成品。

## 替代 curl

```python
info = http(url=url, mode="probe", timeout=25)
{"status": info["status"], "bytes": info["bytes"], "total_ms": info["total_ms"]}
```

- `http` 当前只做 GET：`text` 返回 UTF-8 文本，`probe` 下载后丢弃正文，`download` 原子创建 `path`，可位于工作区外，但不覆盖已有文件。
- 返回状态码、最终 URL、内容类型、正文大小、响应头完成时间、总耗时及平均速度。大小是解码后正文，不是线速字节；不伪造 DNS/TLS 分阶段指标。
- 代理复用应用网络配置和桌面系统代理；统一处理超时、取消、DNS、逐跳重定向、响应大小和内网审批。不会读取浏览器或配置 Cookie。
- 网页正文、图片、PDF 继续使用 `webfetch`；联网搜索使用 `websearch`。它们与原始 HTTP 的职责不同。

## 输出、并发与状态

- 最后一个非 `None` 顶层表达式自动展示，完整值保留在 `_`；赋值不自动展示。
- 未赋值调用最多展示八个短预览，完整值保留在 `_results`，直到下一个产生值的代码块；`print` 不重复回显其返回值。
- 中间数据留在 Python，最终返回决策证据。`observe(value, fields=[...], limit=8)` 可投影表格。
- `batch(name,jobs,limit=...)` 每批调用同一种已启用函数，每项是关键字参数字典，最多 256 项。read/find/grep/ls 默认 6、最多 16 并发；process_run 默认 2、最多 4 并发。进程逐项经过参数校验、审批和路径检查，显式 Shell 与其他程序使用相同通路。
- 只把已确认独立、无共享写入的任务放进同一批；生产者/消费者、安装后构建、同一项目的修改继续串行。重复测速或延迟采样也应串行，避免互相争抢带宽。不会自动识别或改写依赖图，不使用 Python 线程并发调用宿主代理。
- 结果按输入顺序返回 `{ok,value|error}`；一项失败不停止其他独立项，也不自动重试。检查全部结果后再执行依赖步骤；使用 `check=False` 时，`ok` 不代表程序成功，另查 `value.status` 和 `value.exit_code`。用户取消后不再派发排队项，正在运行的进程树按取消逻辑回收。
- 图片原样附在执行结果中，不转成 Python 字符串。输出约 40k 字符；`_last_output` 最多保留 1 Mi 字符，并标记截断。
- 同会话保留变量；关闭、取消、淘汰和重启不恢复内存，已完成写入不回滚，不自动重放。

## 可恢复的上下文裁剪

- `/prune` 先预览下一次请求的目录价格及缓存失效估算；`/prune force` 跳过成本判断，不跳过候选保护；`/prune restore` 撤销最近一次未恢复的裁剪。
- CodeAct 保留执行代码、用户消息、错误/部分失败、最近两次执行结果，以及已识别的修改和进程结果。只裁剪更早、具有完整成功查询调用记录的大输出（至少 2k 字符或含图片）。纯 Python、未知调用或不完整调用记录不作为候选。
- 只改变模型上下文投影：旧输出替换为带 ID 的裁剪标记，原始正文和图片仍在原会话。恢复不重跑代码、不重放写入；原事务已被 compaction 移除时拒绝伪造恢复。
- 不自动裁剪、不新增摘要模型请求。上下文减少不等于实际订阅费用同比例下降，缓存失效也可能使下一次请求更慢。

## 迁移与诊断

不兼容旧的原生 `codemode` 工具历史；请新建会话。旧默认列表不会补工具或自动迁移；在函数面板选择所需能力，或应用 Vanilla 预设并保存默认值。CodeAct 本身没有开关。

GUI 的执行容器来自源码元数据与自定义结果，不伪造原生工具消息。函数调用保留审批、取消、耗时与真实修改 diff。遥测分别统计 Python 执行与内部 I/O，批次记录并发峰值；`process_timeout_capped` 记录申请超时、有效超时和剩余预算，不记录命令参数。复盘使用 `scripts/pimoon-report.py`。执行成功不代表用户任务完成；内部结果不等于模型曝光，嵌套耗时不能相加。

执行块闭合后，先给同一模型响应最多 250 ms 回收正常终态及完整 usage；窗口内失败或输出超限仍不执行。超时继续截流，未知/部分用量不补零、不当成完整费用。这个窗口可能增加最多 250 ms 等待及窗口内的生成，不无限等终态，也不发补账请求；旧记录中未返回的用量不能事后还原。消息与会话报告对缺失用量标明只含已报告部分，目录价格估算不是实际订阅账单。
