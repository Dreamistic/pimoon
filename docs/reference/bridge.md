# 本机委派桥接

桌面后端就绪后独立启动 HTTP 桥接，不依赖 Desktop Web 开关。固定监听 `127.0.0.1`；`PIMOON_BRIDGE_PORT` 可设为 `0..65535`，默认 `0` 自动分配端口。设置该环境变量后需重新启动桌面应用。

连接信息保存在 `PIMOON_HOME/bridge/token.json`：`token` 是 32 字节随机值的十六进制表示，`port` 是实际端口。令牌在重启后保留，端口可能变化。客户端每次重连重新读取此文件；应用停止时连接应直接失败，不在客户端自动排队派单。

所有请求需带 `Authorization: Bearer <token>`。拒绝任何 Origin 头，Host 仅接受 `127.0.0.1:<port>` 或 `[::1]:<port>`。JSON 请求最大 1 MiB。不要把令牌写进日志、提示词、仓库或模型工具参数。同一操作系统用户的其他进程仍可读取令牌；它不是针对本机恶意程序的安全隔离。

## 接口

| 请求 | 参数 / 返回 |
| --- | --- |
| `POST /bridge/tasks` | `{cwd, goal, acceptance: string[], constraints: string[], title?}`；201 返回 `{id}` |
| `GET /bridge/tasks` | 任务快照数组 |
| `GET /bridge/tasks/:id` | 单个任务快照 |
| `GET /bridge/events?after=0&wait=25` | `{epoch, seq, tasks: string[]}`；tasks 仅含变化的 ID |
| `POST /bridge/tasks/:id/dialogs/:dialogId` | `{value, feedback?, answers?}`，value 为字符串或 null；成功 204，已结束 409 |
| `POST /bridge/tasks/:id/messages` | `{text}`；普通文本，运行时插话、空闲时续跑；成功 204 |
| `POST /bridge/tasks/:id/review` | `{verdict, feedback?}`，verdict 为 `accepted` 或 `rejected`；打回必须有意见；成功 204 |
| `POST /bridge/tasks/:id/cancel` | 无请求体；成功 204 |

事件游标仅在当前 epoch 有意义。epoch 变化后重新列出全部任务；即使没有事件，任务查询才是状态依据。长轮询最多等待 25 秒，断开连接会释放等待。

任务快照包含 brief、Git 基线、当前状态、挂起弹窗、交付、验收意见、打回历史及最后执行错误。stalled 附最后一条助手消息的前 2000 字及 `lastMessageId`（当前分支最后一条消息标识）；客户端可据此区分回复文字相同的不同停滞回合。secret/editor 弹窗不返回编辑正文，只能由用户应答。

同一 Git 根目录只接受一个未结束任务；非 Git 目录按真实目录去重。冲突返回 409 和已有任务 `id`。stalled 和 delivered 仍占用该名额；取消、验收通过或会话丢失后释放。同仓库的人工修改不会被阻止。

派单等待本地目录、Git 基线和记录持久化，不等待模型完成；异常慢的磁盘或 Git 预检仍可能增加派单延迟。启动与模型错误记入任务。任务状态不写入任务文件，重启不自动续跑。

在委派客户端最近 60 秒内查询任务或轮询事件时，委派会话的审批与完成通知不再推给桌面；普通会话不受影响。用户仍可在桌面打开同一会话应答或停止任务。

## 当前交付边界

委派会话在 CodeAct 中提供 `ask(question, options?)` 和 `deliver(summary, changes, verification, unverified, objections)`。后五项报告内容除 summary 为字符串，其余均为字符串数组。ask 复用桌面输入/选择弹窗；取消返回 `{answered: false, answer: null}`。答案仅用于澄清需求，不授予操作权限。deliver 持久化报告并由宿主记录当前 HEAD；会话空闲后才进入 delivered。普通回复结束但未调用 deliver 仍为 stalled。

工具按任务记录中的会话 ID 装配，执行资源回收、重新打开与宿主重启后仍可恢复；普通会话不注册这些工具或委派提示。打回后沿用同一会话继续执行。交付记录只能由宿主写入，没有对外提交交付报告的 HTTP 接口。

本机桥接不负责外部客户端的对话、通知和训练数据隔离；客户端应把事件视为外部 agent 数据，自己验证交付 diff 和测试，不把报告当作通过证明。

任务记录原子写入 `bridge/tasks.json`。`bridge/host.lock` 阻止同一配置目录启动多个写入宿主；只自动清理已退出进程留下的锁，不覆盖活跃宿主。不要手动编辑运行中任务文件。
