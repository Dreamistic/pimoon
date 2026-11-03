# CodeAct

pimoon 桌面使用持久 CPython，`codemode` 是模型唯一执行入口。此页描述桌面实现，不代表保留的上游 CLI/Web 已获支持。

## 执行

普通文件分析直接在 Python 中完成，不通过 bash 再启动 Python：

```python
from pathlib import Path
import json
rows = [json.loads(line) for line in Path("D:/data/events.jsonl").read_text(encoding="utf-8").splitlines()]
{"events": len(rows)}
```

允许读取工作区外的普通文件；写入、删除和重命名仍限当前工作区。pimoon 登录凭据和常见用户凭据目录受保护。路径与 audit 检查不是强安全沙箱，不代表可以读取与任务无关的隐私文件。

宿主函数已注入 Python，例如 `read(path=...)`、`bash(command=...)`、`websearch(...)`。启用的函数签名及返回结构由真实 schema 生成，模型无须另找入口。底层能力关闭后不可调用；执行仍经过 SDK 校验、审批与遥测。Python 不直接启动进程、访问网络或调用 FFI。

`batch(name, jobs, limit=6)` 只并发独立的 read/find/grep/ls，最多 16 并发。返回有序的 `{ok, value|error}` 列表。

## 结果与状态

- 最后一个顶层表达式自动展示（`None` 除外），完整结果保留在 `_`，后续可继续分析；赋值和循环内表达式不自动展示。字符串原样返回，列表/字典使用 JSON，图片只显示说明，原始图片块仍单独转交。未知对象/循环引用给出标记，不调用自定义 repr。
- `print` 仍可显式输出，不自动重复；错误、内部工具失败即使没有 print 也会报告。不要为获取输出重放写入。
- 返回前筛选或汇总；`observe(value, fields=[...], limit=8)` 可投影表格。
- bash 返回 output/status/exit_code/wall_time_seconds/truncated/capture_complete，可含 full_output_path；失败可能通过字段或异常表达。
- 输出展示最多约 40k 字符，`_last_output` 最多保留 1 Mi 字符；截断和保留不完整分别标记。
- `native_read(path)` 从宿主读取 UTF-8 普通文件，最多 4 MiB；与 Python 共用受保护路径集合。
- 图片由宿主原样附在父结果中，不经 Python 字符串化。
- 同会话保留变量；关闭、取消或淘汰不恢复内存，已完成写入不回滚。

## 历史与遥测

GUI 按父子关系展示调用；nestedCalls 保存调用事实，成功修改的 diff 单独持久化，不保存所有中间正文。

复盘使用 `scripts/pimoon-report.py`。执行成功不代表任务完成，内部输出不等于模型曝光，嵌套耗时不能相加。
