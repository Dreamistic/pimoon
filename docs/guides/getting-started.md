# 安装与启动

当前只交付 Windows x64 桌面目录版。环境要求、认证限制和部署步骤见[根目录 README](../../README.md)。

```powershell
git clone https://github.com/Dreamistic/pimoon.git
cd pimoon
bun install --frozen-lockfile
bun run build:desktop
.\dist\pimoon\pimoon.exe
```

首次安装需要联网，包含 Electron 下载。依赖固定版本并提交锁文件，不删除锁文件、不使用 `latest` 升级。

## 常见问题

- **找不到 Python**：安装 Python 3.12+ 并加入 PATH，确认 `python --version`；成品也需要 Python。
- **找不到 Rust / linker**：安装 Rust stable 和对应链接器；MSVC 用户安装 Visual Studio C++ Build Tools。自定义工具链可设置 `PIMOON_RUST_BIN`。
- **没有 Electron 运行时**：不要跳过依赖安装脚本。检查 `node_modules/electron/dist/electron.exe`，确认网络允许下载 Electron。
- **下载停滞**：确认终端网络或代理可访问 npm 和 Electron；浏览器能访问不代表 Bun 使用相同代理。不要把私人代理地址写进仓库。
- **封装报 EEXIST**：输出目录已存在。移走旧目录或用 `node scripts/build-pimoon-portable.mjs --output dist/pimoon-next`，不要覆盖运行中的成品。
- **能打开但不能聊天**：启动和模型认证是两件事。使用自己的 Codex 登录，确认凭据、模型权限与额度；不自动切换其他端点。

## 数据与升级

数据默认保存在 `%APPDATA%/pimoon`，可用 `PIMOON_HOME` 覆盖，不自动读取 `~/.pi`。同步原应用登录必须自己显式指定来源，详见 README。

更新源码后运行 `bun install --frozen-lockfile`，在独立目录重新构建、验证，正常退出旧版后再切换快捷方式。移动成品时必须移动整个目录。

保留的 TUI / Web 入口未作为 pimoon 交付验收，其历史文档不能替代当前桌面安装流程。
