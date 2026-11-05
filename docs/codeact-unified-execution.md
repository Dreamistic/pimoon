# CodeAct 统一执行接口

2026-11-05。用户确定优先降低模型心智负担；成熟读取并行可以先交付，不再以完整对话提速显著作为唯一上线门槛。此前自然模型 A/B 的性能结论保持不变，见 codeact-scheduling-live.md；本轮价值是接口收敛与正确执行。

## 行为

- 模型仍只声明一个原生 execute，内部写普通同步 Python。
- 删除公开的 batch 与 process_run 名称和手工并发说明，无兼容别名。使用已知的 subprocess.run，返回标准 CompletedProcess，读取 returncode/stdout/stderr；check=False 为标准默认，check=True 抛 CalledProcessError，进程超时抛 TimeoutExpired，不重置 Python 状态。
- subprocess.run 支持 argv 字符串数组、cwd、env、timeout、check、capture_output、text、stdout/stderr 的默认流/PIPE/DEVNULL。捕获输出要求 text=True，UTF-8；不承诺完整 subprocess API，不支持输入流、Popen、Shell、二进制捕获或任意选项。未支持参数在发起进程之前拒绝，不悄悄忽略。
- env=None 继承，显式 env 按标准完整替换；审批目标区分环境继承/替换，不复用错误范围的授权。默认进程时限 300s，最大 1800s，仍预留代码块清理时间；异常记录实际裁剪后的时限。
- 程序输出沿用 64KiB 每流上限，截断有明确提示；已完成副作用不因输出不完整自动重放。
- CompletedProcess 自动展示标准结果字段，不迫使模型额外执行一轮查看自定义字典。审批意见与程序数据分开，意见进入 execute 输出，不混入程序 stdout/stderr。
- 已验证的独立只读赋值及简单字符串推导式默认自动调度。每组上限 64、并发 6；其他写法保守串行。进程和写入串行，不让模型决定副作用能否并行。
- 只读失败时已派发后项可能完成；停止继续派发，保留原始赋值/异常次序，不执行依赖写入。此已知边界不改成“任意 Python 精确串行等价”。

内部进程授权标识仍为 process_run，以保留现有审批规则、开关、遥测及进程树回收。它不再是模型/Python 可调用名称，不迁移或扩大旧权限；禁用能力后，旧 subprocess.run 引用也不能启动进程。Python 其他线程在写协议帧前拒绝，避免自行开线程破坏共享管道。

## 验证

- 核心 Node 85 项通过，包含标准返回值、非零退出、UTF-8、环境替换、超时与代码块预算、取消进程树、旧名称消失、读取自动并行/失败与原执行器回归。
- SDK 定向 9 文件 61 项通过，含真实审批暂停/继续/拒绝、辅助卡片、跨轮变量、动态函数能力、原生异常、自然程序重放、目录和文本执行；自动读取/遥测集成另 1 项通过。
- 固定读取 A/B 1 项（72 次真实执行）通过；进程/预算/更新器/MCP 定向另 35 项通过。
- 隔离 TypeScript 类型检查通过；未弹出 GUI、未安装/更新/重建依赖。
- 两组真实 Sol/low/SSE 自然生成程序，均在一个 execute 内用 subprocess.run 完成成功/退出7两种模式，捕获结果、写入及回读；2/2 业务通过、4/4 模型响应 usage 完整，命令各执行一次。没有 batch 或 process_run 生成，也没给模型规定 Python 源码。数据见 docs/reference/benchmarks/codeact-standard-process.csv。
- 上述真实两组使用相同新接口，只切读取调度，不能宣称是旧/新接口性能对照；它验证标准接口能被自然使用。先前完整任务 A/B 与本轮静态说明缩减分别报告，不用小样本耗时承诺整轮加速。
- 核心原生说明从 418 token / 1979 字符减至 332 token / 1660 字符（o200k_base）；移除两个专用名称，进程目录改为标准签名。此仅是说明文本测量，不是供应商账单收益。

中途实际发现：审批反馈追加展示文本会使 SDK 撤销 structuredContent。直接解析回显文本导致进程已执行、后续步骤却因 TypeError 中止。现从受控执行器的已校验 details 取程序数据，反馈单独回传；真实“批准后仅执行一次并继续后续写入”用例已复测通过，不保留字符串解析兜底。

## 迁移与更新边界

历史 execute 内容仍可阅读，但不可复制旧批次/进程名称执行；新代码直接用普通同步调用与 subprocess.run。旧文本协议继续只读，不新增兼容入口。

主工作区存在用户未提交的报告和 Runtime 改动；集成必须保留这些改动，提交仅含本任务。桌面构建来自干净提交，不把用户其他未提交功能打包。

运行中的应用不能原地覆盖或强杀。退出全部 pimoon 窗口后从根启动脚本应用；未重启不能声称当前会话已用上新接口。

## 正式源码与成品交付

- main 功能提交 `52dddcc`。其树与已验收、已构建的隔离提交 `670525b` 完全一致（tree b0942ef0f0568435b0fc560ca4767b326a738f77），没有把用户未提交的报告/Runtime 改动打包。
- 主工作区四个共享文件三方合并：保留用户的结构化输出、Runtime 状态/启动等待指标、原生读写计数及新增测试；只把任务树暂存提交。合并工作树隔离 tsc、Node 86 项和 SDK 定向 23 项通过，用户其余修改保持未提交。
- Windows desktop --dir 与便携封装成功。封装后 backend/main/preload/package、Python 代理与调度模块、Rust 执行器等 10 个文件逐项与干净构建校验一致。
- 新增 `scripts/smoke-codeact-artifact.mjs`；成品用 ELECTRON_RUN_AS_NODE + PI_SUBAGENT_CHILD，无窗口、无真实凭据/外网请求，仅精确 Codex URL 的合成网络响应。2 次请求都只声明 execute；旧名称不在 Python 命名空间；两次正式 read 的并发峰值 2；成功及退出7的 subprocess 返回正确，标记只写 once。
- 成品探针独立配置关闭审批，只证明打包桥接；真正暂停、批准、拒绝、反馈继续及不重放由启用审批的 SDK 用例验证。不能把成品审批关闭当成放行流程通过。
- 产物已放在 `dist/pimoon-native-update`，release.json 记录 source commit、backendSha256 和文件哈希。当前 `dist/pimoon` 的后端哈希未变，没有强杀、重启或覆盖正在使用的应用。
- 用户需退出所有 pimoon 窗口，再运行根目录 `启动 pimoon.cmd`；既有更新器会校验待更新后端、保留旧目录后切换。直接点击旧 exe 不触发更新，当前会话仍使用旧接口。
