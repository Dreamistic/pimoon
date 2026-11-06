# 连续执行与读取并发去限

源提交：`6215aa881b8b8948541c8c7a20541e5e9ffe736b`。删除每轮仅一次 execute 的提示限制，允许等待结果后继续执行至完成或需要用户决策；取消固定六路读取并发限制，保留单组 256 项、权限、取消和普通 Python 串行语义。异步失败时同组可能已经全部启动。

验证：47 项调度回归、6 项提示和目录测试、类型检查通过；独立 worktree 构建，补入未跟踪的 assets 构建资源；成品无窗口烟测通过，成品提示已核对。`dist/pimoon-continuous-6215aa8/release.json` 保存源提交及全部文件 SHA-256，入口切换后全部复验。

正式桌面快捷方式已备份并切到 `dist/pimoon-continuous-6215aa8/pimoon.exe`；备份位于 `dist/shortcut-backups/pimoon-before-continuous-6215aa8.lnk`。未结束旧进程、未覆盖旧正式目录。用户须正常退出后从桌面重新打开。

未完成的 read 原文模式合并仍保留在主工作区，未包含在本次成品中。未推送。
