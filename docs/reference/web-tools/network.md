# 网页工具网络配置

`http`、`webfetch`、`websearch` 共用 `web-tools.jsonc` 的 `network` 配置。默认值见 [`agent/defaults/web-tools.jsonc`](../../../agent/defaults/web-tools.jsonc)。

## 代理

```json
{
  "network": {
    "proxy": {
      "enabled": true,
      "http_proxy": "http://127.0.0.1:7890",
      "https_proxy": "http://127.0.0.1:7890",
      "socks5_proxy": ""
    }
  }
}
```

显式代理默认关闭。Desktop 此时跟随系统代理；其他宿主直连。忽略 `HTTP_PROXY`、`HTTPS_PROXY` 等环境变量，不在代理失败时偷偷改为直连。启用显式代理后至少填写一个端点。

| 目标 | 选择顺序 |
| --- | --- |
| HTTP | `http_proxy`、`socks5_proxy`、`https_proxy` |
| HTTPS | `https_proxy`、`socks5_proxy`、`http_proxy` |

HTTP 代理接受 `http://` 或 `https://`，SOCKS5 接受 `socks5://`。端点只含 origin，可包含认证信息。SOCKS5 使用 Undici 的实验性实现。

## 地址检查

直连和代理都先在本地解析目标 DNS。结果须全部为公网地址、配置允许的 fake-ip，或下文精确站点授权允许的普通私网地址。通过代理时使用校验后的 IP，并保留 Host 和 TLS SNI；TLS 证书验证不关闭。代理 DNS 缓存最多 10 秒。

`network.fake_ip_ranges` 只接受 `198.18.0.0/15` 内的子网，用于域名解析结果。URL 直接填写该地址仍会被拒绝。

## 精确 HTTPS 站点授权

`network.trusted_https_origins` 为精确 origin 名单，用于兼容本地代理把公网域名解析成 RFC1918 IPv4 地址（例如 `172.19.x.x`）的环境。不放开整个网段，也不修改系统代理。

当前默认名单：

- GitHub：`https://github.com`、`https://api.github.com`、`https://raw.githubusercontent.com`、`https://codeload.github.com`、`https://objects.githubusercontent.com`、`https://release-assets.githubusercontent.com`。
- npm：`https://www.npmjs.com`、`https://registry.npmjs.org`。
- Python：`https://pypi.org`、`https://files.pythonhosted.org`、`https://docs.python.org`。
- 文档与问答：`https://developer.mozilla.org`、`https://stackoverflow.com`。

名单只允许 HTTPS 标准端口，不接受路径、凭据、IP、通配符或 localhost；不会自动包含其他子域名。即使 origin 命中，回环、链路本地、云元数据、IPv6 ULA 等特殊地址仍不由名单放行；混合 DNS 结果包含一个禁止地址即整体拒绝。普通私网结果的放行是配置授权，不是自动认定这些地址确实属于 fake-IP。

每个 origin 创建独立连接策略，重定向、网页主图和下载目标仍分别验证。保留原始域名的 Host、SNI 与证书验证。名单内合规地址免重复网络审批，下载落盘权限不因此放开。网页内容仍是不可信数据。

在网页工具配置中用数组替换名单；设置 `"network": { "trusted_https_origins": [] }` 可撤销全部站点授权。配置变化后使用新的连接池签名与网页快照键，不能从旧权限快照继续分页；不强行终止此前已经开始的调用。

2026-11-05 验证：类型检查通过；网页工具与审批定向测试 398 通过、2 跳过。隔离源码运行时经本机现有代理访问 GitHub 页面、GitHub API、raw.githubusercontent.com、npm registry、PyPI，均得到 HTTP 200；未读取用户 Cookie、未关闭 TLS 验证。其余名单站点未逐站在线验收。

### Windows 待更新成品

- 功能源提交 `89ca4da`，从该提交的干净 worktree 构建，未夹带主工作区未提交改动。
- Windows 便携成品完成两组无窗口验收：既有原生 execute／进程桥接探针通过；新增合成模型驱动的真实 execute 内 `http` 经现有代理读取 GitHub API 与 raw.githubusercontent.com，均 HTTP 200。模型响应使用本地合成夹具，不读取真实凭据；外网部分只访问这两个已授权站点。
- 成品已登记到 `dist/pimoon-native-update`，`release.json` 保留源提交及后端、配置和运行时文件哈希；当前运行目录未改动。
- 退出全部 pimoon 窗口后，通过仓库根目录 `启动 pimoon.cmd` 应用更新。更新器校验后端哈希并保留旧版本；直接点旧 exe 不触发更新。当前会话在切换前仍使用旧网络策略。

### 2026-11-06 源码复验与旧版排查

- 当前 `dist/pimoon/resources/app/resources/agent/defaults/web-tools.jsonc` 不含 `trusted_https_origins`，运行后端也不含对应授权逻辑；用户配置目录没有 `web-tools.jsonc` 覆盖。因此当前会话的 GitHub 地址拒绝来自旧成品，而非源码名单缺项。仅向旧版配置添加新字段无法替代后端升级。
- 当前源码的真实网页运行时在 `.tmp/tests/github-network` 隔离环境中访问本次目标提交页面、该提交的 GitHub API 和 raw 源码，三者预检查均为 `trusted`，`http` 均返回 HTTP 200；同一提交页面的 `webfetch` readable 调用成功。未读取用户 Cookie、未修改系统代理、未关闭证书验证或扩大私网授权。
- 定向回归：`node node_modules/vitest/vitest.mjs run tests/harness/web-tools/trusted-sites.test.ts tests/harness/web-tools/network-errors.test.ts tests/harness/approval/trusted-sites.test.ts tests/harness/web-tools/config.test.ts`，87 项通过。
- 打包应携带当前源码后端、默认配置和 schema，并在更新后用成品真实工具再次验收；当前运行进程不会因源码修改自动切换策略。此次无需增加站点或网段授权。
- 随后从干净提交 `f5daf1d` 构建 `dist/pimoon-stable-f5daf1d`，`release.json` 记录源 commit 与关键文件 SHA-256。无窗口成品通过原生 execute、只读并行和进程桥接验收；同一成品的真实 execute 内访问上述 GitHub 页面、API、raw 地址均 HTTP 200，webfetch readable 成功。测试只用隔离配置与合成模型凭据，不读取用户 Cookie。
- 桌面 `pimoon.lnk` 已重新读取并确认指向该新版的 `pimoon.exe`，旧快捷方式保存在 `.tmp/tests/pimoon-shortcut-before-stable.lnk`；旧运行目录未覆盖。当前旧进程须由用户正常退出，再通过桌面快捷方式打开新版。没有运行可见 GUI 验收。

## 其他私网请求

`http` 与 `webfetch` 的其他私网访问通过[审批模块](../approval-gate/README.md)授权。授权绑定完整 origin 和当次解析地址，每次调用重新解析，重定向与主图下载各自检查。关闭审批模块后，工具仍执行地址检查。

`websearch` 的 endpoint 不接受私网 IP 字面量，域名连接遵循上述网络策略；3xx 作为错误处理。名单不自动包括搜索服务提供商。

## Cookie

Cookie 供 `webfetch` 使用，默认文件为 `PIMOON_HOME/agent/cookies.txt`，可用 `PI_WEB_TOOLS_COOKIES` 指定路径。文件采用 Netscape/Mozilla 格式。Unix 下限制权限：

```bash
chmod 600 ~/.pi/agent/cookies.txt
```

发送 Cookie 需满足：

1. `webfetch.cookies.enabled` 为 true。
2. `webfetch.cookies.domains` 命中目标主机。
3. Cookie 自身的 domain、path、secure 和 expiry 匹配。

`example.com` 匹配该主机，`*.example.com` 匹配子域名。

认证确认模式：

| 值 | 行为 |
| --- | --- |
| `always` | 每次发送前确认 |
| `session` | 每个 origin 每会话首次确认 |
| `never` | 命中允许列表后直接发送 |

当前默认启用 Cookie，允许 `*.reddit.com`、`*.youtube.com` 和 `*.bilibili.com`，确认模式为 never。加载 Cookie 文件前请检查这组配置。

TUI、GUI 和 RPC 提供确认接口。无界面且需要确认时返回 `AUTH_CONFIRMATION_REQUIRED`。

响应的 `Set-Cookie` 只更新内存 CookieJar。Cookie 名称和值不会进入模型结果和错误展示。
