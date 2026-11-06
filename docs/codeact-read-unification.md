# 统一读取接口与调度边界

## 决策与迁移

- 模型只使用 `read(path=...)`：默认展示文本、图片/PDF；`mode="raw"` 返回完整 UTF-8 字符串，保留 BOM、CRLF 和 Unicode，不加包装。原文拒绝范围参数和媒体、二进制、非法 UTF-8；上限为 4 MiB 与配置文件上限的较小值，不以截断成功代替完整数据。
- 两种模式复用同一权限、取消、稳定文件快照和版本观测；原文后可直接 edit/write，文件发生外部变化仍拒绝过期版本修改。
- 删除 Python native_read、独立 Node 读取实现、Rust 原文操作码及专用遥测，不保留别名。旧源码迁移为 `read(path=p, mode="raw")`；缺失统一 `ToolError.code == "FILE_NOT_FOUND"`，并发结果同码。读取进入 read 宿主统计，不再展示 native_read 专用指标。
- 审批追加备注与原文分离回传，JSON 解析不受污染；仅在当前首文本与文件工具 details 完全一致时拆分备注，结果被替换不能从旧 details 恢复正文。
- 独立输入使用 collect，全组完成后检查必需输入再进入依赖步骤；普通 Python 保持串行，未全局吞异常。固定六路限制已取消，单组 256 项、只读白名单及取消保留。
- 去限不代表无限资源：结果帧上限为 20 MiB（2026-11-06 从 8 MiB 调大，Node/Rust/Python 一致；按序列化后的 UTF-8 字节数计算，不按可用内存动态调整），超过时抛 RESULT_TOO_LARGE，要求缩小读取量或组，不截断、自动重放或回滚。大量原文仍应按需要筛选；未引入自动 DAG、任务句柄和写入并发。

## 验证口径

使用隔离 HOME/PIMOON_HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP，无可见 GUI、无真实凭据、未安装依赖。真实文件命令及 SDK 夹具覆盖原文解析、版本修改、外部冲突、权限拒绝、禁用、取消、中间缺失不漏读、依赖写入屏障、审批备注和结果替换。Rust 离线重编译并测试；类型检查和定向回归结果在交付时记录。

历史自然模型程序仅在回放入口迁移读取 API，不修改保存的原始源码；回放不等于新模型自然生成试用。A/B 使用等价固定程序核对串行与显式并发输出，不把局部时延当完整对话提速。未进行新的在线模型采样。

源码验收：Rust 1 项测试、Node 76 项、Vitest 19 文件 150 项全部通过，TypeScript 类型检查通过。此前测试发现的加载器不匹配已改为真实文件工具 Vitest 测试，错误的成功状态断言已按 applied 修正；没有掩盖失败或跳过用例。

## 2026-11-06 回传上限调整

- 用户选择固定 20 MiB，不增加按剩余内存动态分配或分帧机制。仅调整 CA02 通信帧边界；单文件原文 4 MiB、模型输出预算与并发项数不变。
- 隔离验证：Rust 2 项、Node 70 项及 `tsc --noEmit` 通过。direct/Rust 两条实际通信链路均完整返回约 15 MiB 的 Unicode 批次，顺序及跨块数据保留；约 21 MiB 批次仍返回 `RESULT_TOO_LARGE`，状态不丢失、不截断成功或自动重放。
- Node 解码器与 Rust 帧读写覆盖恰好 20 MiB 成功及越界拒绝。重新编译的是源码资源执行器，尚未构建或切换正式桌面成品；下面保留此前统一读取版的交付记录。

## 正式桌面交付

- 成品源提交：`db7ae7aee688390a3462222cfa282b462473c269`；独立目录：`dist/pimoon-unified-read-db7ae7a`。从独立 worktree 构建，显式复制本次离线重编译的运行时资源，依赖仅借用。
- 无窗口成品烟测通过：原文与展示读取、统一缺失错误码、单项 ToolError、并发元数据、标准进程及副作用仅一次；2 次合成模型请求均只声明 execute。成品中旧 native_read 定义和操作码不存在，新连续执行提示保留。
- `release.json` 保存全部 1101 个文件的 SHA-256；快捷方式切换后逐项复验通过。后端 SHA-256：`7f72ecd5341fb26f6ba861bb9e029f1bb3607e89e1014ddea4c66c9edd296e7e`；运行时 SHA-256：`9379be68e10777465d3d6bc6b0c9dca4436d31b6c4d51deadc27805edc8d5166`。
- 桌面 `pimoon.lnk` 已重新读取并切至 `dist\pimoon-unified-read-db7ae7a\pimoon.exe`；旧快捷方式备份：`dist\shortcut-backups\pimoon-before-unified-read-db7ae7a.lnk`。旧正式目录及运行进程不动，用户正常退出全部窗口后从桌面重开才使用新版。
- 未启动可见 GUI，未运行 E2E，未推送远端。
