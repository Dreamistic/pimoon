# 文档

当前交付范围、数据目录和安装入口以[根目录 README](../README.md)为准。部分文档仍保留上游 TUI / Web 行为，不代表 pimoon 已验收支持。

## 用户使用指南

| 文档 | 内容 |
| --- | --- |
| [安装与启动](guides/getting-started.md) | Windows 桌面源码构建、部署与升级 |
| [配置](guides/configuration.md) | 模型、工具、模块和项目配置 |
| [TUI](guides/tui.md) | 终端操作、快捷键、会话与模板 |
| [GUI](guides/gui.md) | 工作区、会话、文件、模型和设置 |
| [远程访问](guides/remote-access.md) | Web 服务、Desktop Web、SSH 和 TLS |
| [故障排查](guides/troubleshooting.md) | 配置错误、模型、LSP、界面与日志 |

## Reference

[按模块查阅](reference/README.md)。每个模块的首页介绍能力并链接到配置、接口和实现专题。

配置路径与合并规则统一见[配置分层](reference/runtime/configuration.md)。命令语法与入口见 [Reference 命令索引](reference/README.md#命令索引)。

## 设计方案

以下文档记录设计目标，不代表所有目标均已交付；当前行为以 Reference 为准。

- [自主记忆与跨工作区操作](design/autonomous-memory.md)：AI 自主沉淀经验、短索引与按需读取、并发一致性和操作安全边界。
