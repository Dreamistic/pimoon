# Pi SDK 1.5.1 升级

2026-11-10 从 npm latest 核对，四个直接 Pi 依赖由 1.4.0 升至 1.5.1，锁文件同步更新传递依赖。

## 适配

- pi-ai 不再导出 Type；CodeAct 使用已有 typebox，保持工具参数和运行时验证行为。
- 上游公共 schema 改用 pi-schema；不将其直接嵌入 TypeBox Optional。模型思考等级通过 Type.Unsafe 显式桥接静态类型，保留上游原始 schema。
- GUI 兼容选项使用公开联合类型约束，不再依赖上游 schema 的 TypeBox 内部类型。网页工具枚举统一使用 TypeBox。
- 无效历史版本不再导致启动日志报错；建立新基线。降级仍保留原已读版本。
- TUI 渲染测试补齐新版 keyText/keyHint 上下文。

## 缓存保温

上游默认由 streaming 改为 idle：运行间最多保温 30 分钟，符合模型缓存有效期和成本条件时才发送额外 API 请求。off 不禁用普通缓存命中。

pimoon 新配置原本显式设置 cacheWarming: off，本次保留；已有配置不迁移、不擅自开启后台付费请求。需要时可在 PIMOON_HOME/agent/settings.json 设置 streaming 或 idle。现有统计已计入 cache_warm 用量，且不把它算作对话轮次。

## 其他变化

Anthropic 官方端点默认启用消息线程；网关需按实际支持配置 supportsMessageThreads。OpenAI 兼容服务不再默认发送空 tools；旧代理若要求工具历史对应 tools 字段，可配置 requiresToolsWithToolHistory。pimoon 自有文件工具不使用上游 GrepOperations.readFile，不受其 context 行来源变化影响。

## 验证环境

借用的 node_modules 保持只读。新版依赖、源码副本及验证均位于 .tmp/pi-sdk-1.5.1；所有用户目录变量重定向至 .tmp/tests。类型检查通过；Node 下 16 个定向测试文件、228 项通过，覆盖 GUI 宿主、模型服务、网页工具、保温统计、会话树及原生 CodeAct。测试使用 Node，不使用 bun --bun。Windows 凭据命令测试需要保留 ProgramFiles，供 SDK 查找 Git Bash；缺失时可能错误选中 WSL bash。
