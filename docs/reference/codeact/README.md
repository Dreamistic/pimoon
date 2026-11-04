# CodeAct

Windows 桌面与其无界面子代理只使用文本 CodeAct。没有 `codemode` 工具，也没有模型原生工具声明；`<execute>` 代码块直接进入持久 CPython。函数目录由启用能力的真实 schema 生成。

## Python 与函数

普通数据处理使用标准库或已安装的项目函数，不启动另一个 Python：

```python
from pathlib import Path
import json
rows = [json.loads(line) for line in Path("events.jsonl").read_text(encoding="utf-8").splitlines()]
{"events": len(rows)}
```

`read(...)`、`grep(...)`、`edit(...)`、`webfetch(...)` 等是注入的函数，也可通过 `functions.read(...)` 调用。函数参数使用关键字；目录中的 `?` 表示省略，不是传 `None`。关闭 I/O 函数不关闭 Python。下一块执行前同步函数集合，保留其他变量；旧函数引用不能绕过当前权限。

文件读取可以离开工作区；Python 写入、文件修改和下载仍限工作区，凭据路径受保护。这些检查不是强安全沙箱，也不是任意读取隐私文件的授权。

## 替代 Shell

使用程序参数数组、工作目录和局部环境覆盖，不拼接 PowerShell/Bash 字符串：

```python
env = {"JAVA_HOME": "D:/tools/jdk", "ANDROID_HOME": "D:/tools/android-sdk"}
process_run(argv=["npm", "run", "build:android"], cwd="webapp", env=env, timeout=600)
process_run(argv=["./gradlew.bat", ":app:assembleDebug", "--console=plain", "--no-daemon"],
            cwd="webapp/android", env=env, timeout=1200)
```

- `cwd` 默认工作区；`env` 只覆盖该进程的继承环境，不改变 Python 或宿主环境。
- Windows 的 npm/npx 启动入口转换成 Node CLI，Gradle Wrapper 转换成 Java 主类。不运行这些 `.cmd/.bat` 包装；需要本机安装对应 Node/JDK。
- 不展开 `JAVA_OPTS`、`GRADLE_OPTS` Shell 字符串；需要这些选项时直接传 Java 参数数组。任意批处理入口不支持，改用真实可执行文件或把编排逻辑写成 Python。
- `check=True` 是默认值：启动失败、非零退出、超时会抛给当前 Python 块，后续语句不执行。`check=False` 返回结构化 `status/exit_code/stdout/stderr/truncated/duration_ms`，由代码决定后续步骤。
- 单进程默认 300 秒，申请上限 1800 秒；实际超时不超过代码块剩余预算减五秒，为进程树清理和 Python 接收错误留出时间。余量不足五秒时不启动新进程，提示改在下一块执行。整个代码块最多 30 分钟。stdout、stderr 各保留 64 KiB，超出标记截断。
- 普通进程超时作为函数错误返回，不清空 Python 变量；代码块超时、用户取消或解释器崩溃仍可能丢失内存。审批等待、系统清理阻塞等耗尽外层预算时，不能保证保留状态。
- 以前台进程结束为完成条件；不要把常驻服务当成会自行结束的命令，本次不提供后台任务管理器。
- 取消或超时回收活动进程树：Windows 使用 `taskkill /T /F`，Unix 使用进程组；不承诺阻止恶意脱离监督的外部程序。
- 进程执行经过审批，不复用旧 Bash 静态分析规则作隐式放行。工作目录可以是工作区外普通目录，但外部程序使用宿主权限，并非文件沙箱。
- `process_run` 不接受 PowerShell、bash、cmd、curl、wget 作为直接入口。npm 生命周期脚本、构建系统内部仍可能调用系统 Shell；本系统不声称消除了所有间接 Shell。

## 替代 curl

```python
info = http(url=url, mode="probe", timeout=25)
{"status": info["status"], "bytes": info["bytes"], "total_ms": info["total_ms"]}
```

- `http` 当前只做 GET：`text` 返回 UTF-8 文本，`probe` 下载后丢弃正文，`download` 原子保存到工作区内的 `path`。
- 返回状态码、最终 URL、内容类型、正文大小、响应头完成时间、总耗时及平均速度。大小是解码后正文，不是线速字节；不伪造 DNS/TLS 分阶段指标。
- 代理复用应用网络配置和桌面系统代理；统一处理超时、取消、DNS、逐跳重定向、响应大小和内网审批。不会读取浏览器或配置 Cookie。
- 网页正文、图片、PDF 继续使用 `webfetch`；联网搜索使用 `websearch`。它们与原始 HTTP 的职责不同。

## 输出、并发与状态

- 最后一个非 `None` 顶层表达式自动展示，完整值保留在 `_`；赋值不自动展示。
- 未赋值调用最多展示八个短预览，完整值保留在 `_results`，直到下一个产生值的代码块；`print` 不重复回显其返回值。
- 中间数据留在 Python，最终返回决策证据。`observe(value, fields=[...], limit=8)` 可投影表格。
- `batch(name,jobs,limit=...)` 每批调用同一种已启用函数，每项是关键字参数字典，最多 256 项。read/find/grep/ls 默认 6、最多 16 并发；process_run 默认 2、最多 4 并发。进程逐项经过参数校验、审批和路径检查，不开放 Shell 包装。
- 只把已确认独立、无共享写入的任务放进同一批；生产者/消费者、安装后构建、同一项目的修改继续串行。重复测速或延迟采样也应串行，避免互相争抢带宽。不会自动识别或改写依赖图，不使用 Python 线程并发调用宿主代理。
- 结果按输入顺序返回 `{ok,value|error}`；一项失败不停止其他独立项，也不自动重试。检查全部结果后再执行依赖步骤；使用 `check=False` 时，`ok` 不代表程序成功，另查 `value.status` 和 `value.exit_code`。用户取消后不再派发排队项，正在运行的进程树按取消逻辑回收。
- 图片原样附在执行结果中，不转成 Python 字符串。输出约 40k 字符；`_last_output` 最多保留 1 Mi 字符，并标记截断。
- 同会话保留变量；关闭、取消、淘汰和重启不恢复内存，已完成写入不回滚，不自动重放。

## 迁移与诊断

不兼容旧的原生 `codemode` 工具历史；请新建会话。旧默认列表不会补工具或自动迁移；在函数面板选择所需能力，或应用 Vanilla 预设并保存默认值。CodeAct 本身没有开关。

GUI 的执行容器来自源码元数据与自定义结果，不伪造原生工具消息。函数调用保留审批、取消、耗时与真实修改 diff。遥测分别统计 Python 执行与内部 I/O，批次记录并发峰值；`process_timeout_capped` 记录申请超时、有效超时和剩余预算，不记录命令参数。复盘使用 `scripts/pimoon-report.py`。执行成功不代表用户任务完成；内部结果不等于模型曝光，嵌套耗时不能相加。
