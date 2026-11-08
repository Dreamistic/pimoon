# HTTP 流式下载修复与桌面交付

## 问题与处理

旧 http 的下载与测速复用了图片的 5 MiB 额度，并先把整个响应读入内存才写盘。22 MiB 安装包因此被错误地挡在图片边界，临时调大图片额度不是正确解决办法。

源码 `5707c198988619ff984de068161db6853d0ac310`：

- 下载与测速独立使用 `webfetch.download.response_bytes`，默认 128 MiB，可配置 64 KiB–1 GiB；网页 10 MiB、图片 5 MiB 不变。
- 公共 HTTP 读取器支持逐块消费者：下载等待每块落盘，测速逐块丢弃；按实际解压后字节计数，不把大正文放进模型结果或 CA02 帧。
- 复用现有 DNS、系统/显式代理、TLS、重定向、取消和文件授权。目标队列覆盖全下载，已有文件在请求前拒绝，成功后硬链接原子创建目标；失败、超时或取消删除临时文件。
- 超限明确给出配置键和当前额度；不自动提额、重试、换镜像或转外部下载器。HTTP 503/504 属于上游失败，不能声称额度修复会消除它们。

## 验证

测试的 PIMOON_HOME/HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP 均隔离到 .tmp/tests。没有测试数据写入真实用户配置、没有安装或重建依赖。

- 23 个定向文件：408 项通过，1 项既有平台条件跳过；`tsc --noEmit`、`git diff --check` 通过。
- 真实 24 MiB 本地响应在结束前已产生临时文件，成功后大小及内容校验一致。覆盖无 Content-Length、压缩膨胀、超限配置键、代理下载、重定向、同目标并发、已有文件保护、断线、超时、取消及写入错误。
- 共享读取器回归网页、图片/PDF、搜索与可选地址保护。没有新增或运行可见 GUI/E2E。

```text
node node_modules/vitest/vitest.mjs run tests/harness/web-tools tests/pimoon/codeact-http.test.ts tests/harness/extensions/web-tools.test.ts tests/gui/host/config/module-config.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

## 正式桌面版

- 先提交再从独立 worktree 构建；source tree `8365ca3cb416d398de7e491338f0773f6d205b83`。成品 `dist/pimoon-download-5707c19`，依赖只读借用。
- 按旧 release.json 验证 71 个 Electron 文件后复用运行时；原生执行器源码未变，复用已验收执行器并校验摘要。没有覆盖运行中的旧正式目录。
- 成品无窗口烟测使用隔离目录和本地合成 OAuth/模型网络，2 次请求均只声明 execute；真实成品 http 完整下载 25,165,824 字节，结果只回传元数据，已有进程副作用仍为 once。不使用真实凭据，不消耗模型额度。这不是可见 GUI 或真实外网站点下载验收。
- release.json 记录全部 1105 个文件的 SHA-256；快捷方式切换后逐项复验通过。
- 后端 SHA-256：`823bb957617d0091f1932cf9542166c8ec788e59c9f4a18c341179f16c54cefa`。
- 执行器 SHA-256：`9b92f3698dc96803d73e9e0d4c59fc593f301dc88bfbaabf9c5f06e8a6a3d4fe`。
- 发布清单 SHA-256：`f571ac1e3d45b14f356741ff05dd81d92b9ac0676615d20aca44aae64ec65cdc`。
- 桌面 pimoon.lnk 已重新解析并切到新成品；旧快捷方式备份 `dist/shortcut-backups/pimoon-before-download-5707c19-20261108-123450.lnk`。旧目录与进程保留，用户正常退出全部窗口后从桌面重新打开才会加载新版，当前会话不会热更新。

本轮没有修改 ClashMi、Tailscale、Windows 路由或防火墙，也未将待办的 B 站回国通道描述成已完成。未推送远端。
