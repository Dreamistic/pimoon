# 构建与资源

当前仅验证 Windows x64 桌面目录版。环境准备见[安装指南](../../guides/getting-started.md)。标准流程是 `bun install --frozen-lockfile`、`bun run build:desktop`；依赖固定版本并提交 `bun.lock`，升级时须重新验证构建适配器。

## 构建阶段

1. `python -X utf8 -B scripts/build-pimoon-runtime.py`：从 PATH 或 `PIMOON_RUST_BIN` 查找 Rust，执行离线、锁定模式的测试与 release 编译。执行器没有外部 Cargo 依赖，生成的 `assets/runtime/` 不入库。
2. `bun scripts/build.mjs desktop --dir`：生成 `dist/desktop/app`，默认并发构建 GUI、资源和桌面入口。`--serial` 用于串行对照；`--output <新目录>` 可生成独立源码产物。
3. `node scripts/build-pimoon-portable.mjs`：从已安装的 Electron 依赖复制运行时，应用资源放入 `dist/pimoon/resources/app`，并设置图标与应用标识。只支持 Windows x64，拒绝已有输出目录。

封装脚本的 `--output <新目录>` 指定最终分发目录，与上一步的输出是不同阶段，不能混用。封装当前读取默认 `dist/desktop/app`。

`PIMOON_ELECTRON_DIST` 可指定原始 Electron 分发目录，必须含 `electron.exe`；默认不需要设置，不依赖其他应用安装目录。保留 Electron / Chromium 许可证，应用同时包含根目录 LICENSE、NOTICE 和文档资源。

## 资源与边界

桌面产物内置 Electron、前后端、Python worker、Rust 执行器、PDF/WASM 资源和当前平台原生模块。运行仍需 PATH 中的 Python 3.12+；Git、语言服务器和其他程序取决于具体任务。

配置与缓存只使用 `PIMOON_HOME`（默认 `%APPDATA%/pimoon`）。构建只收集仓库默认配置和明确的依赖资源，不打包用户认证、会话或本地运行数据。

## 验证与分发

定向类型检查、运行时测试和无窗口成品烟测见[根目录 README](../../../README.md#验证)。测试数据必须隔离，不把真实登录作为构建和离线测试前提。

分发整个成品目录，不单独复制 EXE。不覆盖运行中的应用、不修改用户快捷方式。构建成功不等于完整 GUI、登录续期或跨平台验收。

底层脚本保留的 TUI / Web 和其他平台选项不代表当前交付范围。默认 `bun run build` 只执行桌面构建。
