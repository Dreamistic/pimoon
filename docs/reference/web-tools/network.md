# 网页工具网络配置

`http`、`webfetch`、`websearch` 共用 `web-tools.jsonc` 的 `network` 配置。默认值见 [`agent/defaults/web-tools.jsonc`](../../../agent/defaults/web-tools.jsonc)。

## 默认不限制网络地址

`network.restrict_private_addresses` 默认为 `false`：

- 允许公网、本机、局域网、fake-IP 和特殊地址，包括云元数据地址；不要求网络访问审批。
- 首次请求、重定向、网页主图和搜索端点使用同一策略。不再需要逐站加入信任名单。
- 直连使用系统 DNS；显式代理或桌面系统代理接收原始域名，不要求本地先解析目标并固定 IP。
- 默认搜索 `include_domains`、`exclude_domains` 都为空。用户显式配置或查询中的 `site:` / `-site:` 仍生效。

这是宽权限模式：不可信网页可能诱导模型请求本机或内网服务。网页内容仍应视为数据，不能作为授权指令。无需也不会自动读取浏览器凭据。

继续保留 HTTP(S) 协议与 URL 格式校验、TLS 证书验证、取消、超时、重定向次数和响应大小上限。下载落盘仍受文件审批和路径保护。网站的 403、验证码、登录、限流，以及模型供应商拒绝不由此解除；网页抓取仍不执行页面 JavaScript。

修改配置可热生效，网络策略变更使用新的连接池和快照键；不强行终止已开始的调用。旧版程序需正常退出后重新打开新版，改源码不会改变运行中的进程。

## 代理

```json
{
  "network": {
    "restrict_private_addresses": false,
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

## 可选地址保护

设置 `"network": { "restrict_private_addresses": true }` 恢复地址检查和私网网络审批：

- 直连和代理都在本地解析目标 DNS。结果须全部为公网地址、允许的 fake-IP 或可信站点的普通私网地址。
- `fake_ip_ranges` 只接受 `198.18.0.0/15` 内子网，只放行域名解析结果，不放行 URL 字面 IP。
- `trusted_https_origins` 只接受精确 HTTPS 标准端口 origin，允许对应域名解析到 RFC1918 IPv4；不自动包含子域名，不放行回环、链路本地、元数据和 IPv6 ULA 地址。默认名单见配置文件。
- 其他 `http`、`webfetch` 私网访问由[审批模块](../approval-gate/README.md)授权，绑定完整 origin 和当次解析地址。关闭审批模块不关闭地址检查。
- 搜索端点不接受私网 IP 字面量。代理使用校验后的 IP，保留 Host、TLS SNI 和证书验证，目标 DNS 缓存最多 10 秒。

地址保护关闭时，fake-IP 和可信站点名单不参与请求拦截。

## Cookie

Cookie 仅供 `webfetch` 使用，默认文件为 `PIMOON_HOME/agent/cookies.txt`，可用 `PI_WEB_TOOLS_COOKIES` 指定路径。文件采用 Netscape/Mozilla 格式，应限制文件权限。

发送 Cookie 需满足：

1. `webfetch.cookies.enabled` 为 true。
2. `webfetch.cookies.domains` 命中目标主机。
3. Cookie 自身的 domain、path、secure 和 expiry 匹配。

`example.com` 匹配该主机，`*.example.com` 匹配子域名。网络地址放开不扩大 Cookie 的发送范围。

| 认证确认模式 | 行为 |
| --- | --- |
| `always` | 每次发送前确认 |
| `session` | 每个 origin 每会话首次确认 |
| `never` | 命中允许列表后直接发送 |

当前默认启用 Cookie，允许 `*.reddit.com`、`*.youtube.com` 和 `*.bilibili.com`，确认模式为 `never`。无界面且需要确认时返回 `AUTH_CONFIRMATION_REQUIRED`。

响应的 `Set-Cookie` 只更新内存 CookieJar。Cookie 名称和值不会进入模型结果和错误展示。


## 原始 HTTP 下载与测速

`http(mode="download", path=...)` 逐块写入临时文件，完整成功后原子创建目标；只允许新文件，不覆盖已有文件。`mode="probe"` 逐块丢弃正文，只返回实际字节数和耗时，两种模式都不把整个文件缓冲进内存或模型上下文。

- `webfetch.download.response_bytes`：下载与测速的解压后大小上限，默认 **128 MiB**，可配置 64 KiB–1 GiB。
- `webfetch.limits.response_bytes`：网页和 `http(mode="text")` 的正文上限，默认 10 MiB。
- `webfetch.media.response_bytes`：网页图片的上限，默认 5 MiB；不再限制安装包下载。

已知 Content-Length 超限时提前拒绝；分块响应与压缩内容仍按实际解压后字节检查。超限错误包含对应配置键和当前额度，不自动提额、重试、换镜像或启动外部下载器。配置示例：

```json
{ "webfetch": { "download": { "response_bytes": 33554432 } } }
```

下载复用现有 DNS/代理/TLS、重定向与逐次文件授权。目标写入队列覆盖整个下载，重复目标在请求前拒绝；失败、超时、取消会清理本次临时文件，不留下伪装成品的目标。同一配置下的全新目标可以重新请求，但不把失败当成自动重放授权。HTTP 503/504 等上游错误不因本地额度调整而消失。
