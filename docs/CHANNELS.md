# 通道（Channels）对齐 —— M10

> 本文记录 **24H-OS 对 Hermes 消息通道（messaging platforms）的对齐策略**：
> 以「文档 + 透传」为主，**不在工作台内重写平台适配器**。
> 结论基于本机 Hermes **v0.21.3** 源码（`~/hermes-desktop/home/hermes-agent`）与隔离
> `HERMES_HOME` 实测。**24H-OS 不触碰 `~/.hermes`。**

## 1. 平台归属：适配器由独立 `hermes gateway` 进程持有

Hermes 的消息平台分为两类（详见源码）：

- **核心平台** `gateway/platforms/`：`api_server`（OpenAI 兼容 REST/房间）、`signal`、
  `whatsapp_cloud`、`weixin`、`yuanbao`、`bluebubbles`、`msgraph_webhook`、`webhook`。
- **插件平台** `plugins/platforms/`：`telegram`、`discord`、`slack`、`email`、`matrix`、
  `teams`、`feishu`、`wecom`、`dingtalk`、`google_chat`、`line`、`sms`、`irc`、
  `mattermost`、`ntfy`、`homeassistant`、`buzz`、`photon`、`raft`、`simplex`、`a2a`、
  `whatsapp`。

**关键结论（实测）**：

1. `hermes gateway run` 是**持有平台适配器**的进程。无任何平台 token 时打印
   `WARNING gateway.run: No messaging platforms enabled.` 后**保持运行**（不会退出），
   等待平台配置/消息；空载属于正常退化形态。
2. `hermes serve`（工作台的 gateway，JSON-RPC/WS 后端）**不启动平台适配器**——实测隔离
   home 下仅输出 `HERMES_BACKEND_READY port=<N>` 与 `setup.ready` 事件，**无任何平台/适配器
   日志**。源码注释亦说明 Desktop 后端「不是 gateway」，平台的实时适配器归独立 gateway
   进程（`hermes_cli/web_server.py`：*"The desktop spawns a `hermes dashboard` backend, not a
   gateway"*）。工作台只在 `HERMES_DESKTOP=1` 时让 serve 跑 **cron ticker** 与 hosted rooms。
3. 因此：**想让 Bot 在 telegram/discord/… 上收发消息，需要独立运行 `hermes gateway run`**
   （不是 `hermes serve`）。

> 实测日志（隔离 `HERMES_HOME`，无 token；`timeout 40 hermes gateway run </dev/null`）：
> ```
> WARNING gateway.run: No env user allowlists configured. Messaging platforms default to
>   pairing/allowlist policies and will deny unknown senders unless you configure platform
>   allowlists (e.g. TELEGRAM_ALLOWED_USERS=your_id) or explicitly opt in with
>   GATEWAY_ALLOW_ALL_USERS=true plus dm_policy/group_policy: open on the platform.
> WARNING gateway.run: No messaging platforms enabled.
> ```
> 进程持续运行至外部 SIGTERM（退出码 124 = timeout 兜底），无崩溃、无残留。

## 2. 配置位置与 key

平台凭据写在 **`<HERMES_HOME>/.env`**（无显式 `HERMES_HOME` 时为 `~/.hermes/.env`），
平台行为可另在 `config.yaml` 的 **`gateway.platforms.<name>`** 覆盖。

常见 `.env` key（节选自官方 `.env.example`）：

| 平台 | 关键 env | 说明 |
| --- | --- | --- |
| Telegram | `TELEGRAM_BOT_TOKEN`、`TELEGRAM_ALLOWED_USERS`、`TELEGRAM_HOME_CHANNEL`、`TELEGRAM_WEBHOOK_URL`(可选) | 默认 long-polling；`TELEGRAM_HOME_CHANNEL` 是 cron 投递默认 chat |
| Slack | `SLACK_BOT_TOKEN`、`SLACK_APP_TOKEN`、`SLACK_ALLOWED_USERS` | socket mode |
| Discord | `DISCORD_BOT_TOKEN`、`DISCORD_ALLOWED_USERS` | — |
| Email | `EMAIL_ADDRESS`、`EMAIL_PASSWORD`、`EMAIL_IMAP_*`、`EMAIL_SMTP_*`、`EMAIL_HOME_ADDRESS` | IMAP 轮询 + SMTP 发信 |
| Teams | `TEAMS_CLIENT_ID/SECRET/TENANT_ID`、`TEAMS_ALLOWED_USERS`、`TEAMS_HOME_CHANNEL`、`TEAMS_PORT` | Bot Framework webhook |
| WhatsApp | `WHATSAPP_ENABLED`、`WHATSAPP_ALLOWED_USERS` | — |
| 全局策略 | `GATEWAY_ALLOW_ALL_USERS`、`dm_policy` / `group_policy` | 缺省 pairing/allowlist，会拒绝未知发送者 |

> 安全：工作台**不回显** `.env` 明文（`GET /api/agents/:id/config` 只返回键名）；平台
> token 的写入仍走官方 `hermes config set` 或 profile `.env`（四重保证 / 原子写）。

## 3. 无头（headless）下启用

工作台**不**管理平台进程；推荐由部署方自行拉起：

```bash
# 1) 把平台 token 写入目标 profile 的 .env（或用 hermes config set）
# 2) 在无头环境后台运行（stdin 需 /dev/null，避免交互挂死）
HERMES_HOME=<home> nohup hermes gateway run </dev/null >/tmp/hermes-gateway.log 2>&1 &
```

验收：`grep "No messaging platforms enabled" /tmp/hermes-gateway.log`——**出现该行说明 token
未生效**；配置正确时应出现平台启动/注册日志而非该警告。

## 4. 推荐投递路径：官方 Cron `--deliver`（而非自研 webhook）

Bot 的**输出投递优先用官方 Cron 的 `deliver`**（已集成进工作台 `cron.manage` 薄封装）：

- `POST /api/cron/jobs` body `deliver` 取值：
  `origin` | `local` | `telegram` | `discord` | `signal` | `platform:chat_id` |
  `bot-chat[:profile]`（见 `shared/types.ts#CronJobAddRequest.deliver` 与 `docs/CRON.md`）。
- 平台「home channel」由 `<PLATFORM>_HOME_CHANNEL` 指定（如 `TELEGRAM_HOME_CHANNEL`），
  用于 cron 投递默认目标。
- **无头缺 token 时**：官方会记 `last_delivery_error`（任务本身照常执行），
  故**无头默认建议 `deliver: local`**（只落本地，不尝试平台投递）。
- 定时/触发依赖 gateway（或 `HERMES_DESKTOP=1` 的 serve ticker）在跑；头号风险见
  `docs/CRON.md`。

**自研 `hooks.outbound`（HMAC 签名 webhook）定位为 24H-OS 扩展**：用于把 App 事件推给
**第三方 HTTP 回调**（见 `docs/APP_MANIFEST.md` 与 `server/hooks/outbound.ts`），
**不与官方通道冲突**，也不替代平台适配器。

## 5. Group Chat：明确「不做」

内核确有 Group Chat 能力：`groups.*` RPC + `hosted_room_*`（多 agent 房间、`peer.invite`、
`approve` 等）+ `bot_relay.*`（`server/hermes/` 之外，见
`tui_gateway/methods_groups.py`、`hermes_cli/web_server.py` 的 hosted-room 启动）。
**24H-OS 不实现 Group Chat UI**，理由：

1. 属官方 **Desktop 主战场**（hosted rooms / 房间编排语义由官方驱动）；
2. 需官方 rooms 生命周期、peer 授权、跨进程状态库等完整语义，**投入产出比低**；
3. 已有 Bot=Profile（M9）与 Skill UI，工作台聚焦「单 agent + 功能性 Skill 宿主」定位。

**若未来要做，入口是 `groups.*` RPC + `bot_relay.*`**；代码内以
`TODO(M10+: groups.*)` 标注（见 `server/hermes/subagent.ts` 末尾）。

## 6. 与工作台的边界

| 能力 | 归属 | 24H-OS 行为 |
| --- | --- | --- |
| 平台适配器（telegram/discord/…） | 官方 `hermes gateway` | **不实现**，仅文档对齐 |
| 平台凭据（`.env` / `gateway.platforms.*`） | 官方 | 只读键名 / 经官方命令写入，不回显明文 |
| Bot 输出投递 | 官方 Cron `deliver` | 薄封装 `cron.manage` 透传 |
| 第三方 HTTP 回调 | 24H-OS 扩展 | `hooks.outbound`（HMAC） |
| Group Chat / hosted rooms | 官方 Desktop | **不做**，留痕 `TODO(M10+: groups.*)` |
