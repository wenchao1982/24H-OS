# 核心契约"是否开放"实测（billing / subscription / free_tier）

> 问题：核心契约里有 13 个账号/计费相关的方法（`billing.*` 5 个、`subscription.*` 5 个、`free_tier.*` 3 个）。
> 它们对我们**开放吗**？能拿来当 24H-OS 自己的商业化底座吗？
>
> 复现命令：`node scripts/contract-probe.mjs`（用壳自己的模块起一个隔离的核心，逐个调用并打印原始返回）。
> 以下数据来自 2026-09-16 在本机对 **核心 0.21.3** 的实测 + 源码静态核对。

## 结论（先看这三行）

1. **方法层面全部"开放"**：没有功能开关、没有白名单、没有 license 校验；实调用都能进到参数校验（4 个方法返回 `invalid_request` 是在校验参数，不是拒绝调用）。
2. **数据与操作全部指向 Nous 官方云**：门户地址硬编码默认 `https://portal.nousresearch.com`，token 取自本机 provider `nous` 的登录态；没有 Nous 账号时只能拿到**空态**（`logged_in:false` / `available:false`），写操作会被要求登录（`billing.step_up` 会去连门户，本机实测 30s 超时）。
3. **但基址是可覆盖的环境变量**（`HERMES_PORTAL_BASE_URL` / `NOUS_PORTAL_BASE_URL`）→ 想拿它当自己的计费面板，**技术上可行**：自建一个"门户兼容后端"，核心零改动（见下文选项 B）。

## 一、实测结果（`node scripts/contract-probe.mjs` 原始输出摘要）

| 方法 | 原始返回（截断） | 判读 |
|---|---|---|
| `billing.state` | `{"ok":true,"logged_in":false,"free_tier":false,"can_charge":false,"cli_billing_enabled":false,"charge_presets":[],"balance_display":"—"}` | 本地可读、**fail-open**：无账号不报错，只给空态 |
| `subscription.state` | `{"ok":true,"logged_in":false,"can_change_plan":false,"tiers":[],"usage":{"available":false}}` | 同上（`tiers` 空 = 拿不到套餐表） |
| `usage.bars` | `{"ok":true,"available":false}` | 用量图表无数据源 |
| `free_tier.status` | `{"has_guest":false,"enabled":false,"available":false,"model":"nous/welcome","label":"Nous · free tier"}` | 免费层是**上游的**：匿名身份 + 固定模型 `nous/welcome` |
| `billing.charge_status` | `{"ok":false,"error":"invalid_charge_id","message":"charge_id is required"}` | 参数校验在先 —— 方法本身可用 |
| `billing.charge` | `{"ok":false,"error":"invalid_request","message":"amount_usd is required"}` | 同上 |
| `billing.auto_reload` | `{"ok":false,"error":"invalid_request","message":"threshold and top_up_amount are required"}` | 同上 |
| `subscription.preview` | `{"ok":false,"error":"invalid_request","message":"subscription_type_id is required"}` | 同上 |
| `billing.step_up` | `✗ code=client_timeout`（30s） | **要连门户**（登录/设备流），本机网络到 `portal.nousresearch.com` 不通/极慢 |
| `setup.runtime_check` | `{"ok":false,"error":"Hermes is not connected to any AI provider yet… (the free Nous tier needs no API key), type /login in chat…"}` | 上游把"未配模型"和"Nous 免费层"写在同一句引导里 |

顺带确认可用（说明这些是真开放的）：`profiles.list`（该 profile 下有 **58 个技能**）、`toolsets.list`（browser 工具集 18 个工具、enabled=true）、`plugins.list`、`mcp.catalog`（官方 MCP 目录）、`cron.manage`、`insights.get`。

## 二、静态证据（源码）

| 事实 | 位置 |
|---|---|
| 门户默认地址 `https://portal.nousresearch.com` | `hermes_cli/nous_billing.py:19` |
| 门户地址可被环境变量覆盖 | `hermes_cli/nous_billing.py:102`（`HERMES_PORTAL_BASE_URL` / `NOUS_PORTAL_BASE_URL`） |
| token 来自本机 provider `nous` 的登录态 | `hermes_cli/nous_billing.py:146-175`（`get_provider_auth_state("nous")` → `resolve_nous_access_token()`，失败即 `_billing_not_logged_in()`） |
| 请求带 `Authorization: Bearer <token>` | `hermes_cli/nous_billing.py:250` |
| 读视图**不需要 scope、fail-open** | `tui_gateway/methods_session.py:1573`（`billing.state` 注释："no account to bill, so its state is answered locally … without a portal round-trip"） |
| 写操作要走门户 + scope（403 → `insufficient_scope` → `billing.step_up`） | `tui_gateway/methods_session.py:1560`、`tui_gateway/billing_view.py:23-33`（错误映射） |
| 免费层 = 匿名身份 + `nous/welcome` | `hermes_cli/anon_auth.py:45`（`GUEST_MODEL`）、`:57`（`FREE_TIER_LABEL`）、`:289 mint_guest`（向门户联网铸造身份） |
| 门户兼容后端要实现的端点（共 8 个） | `hermes_cli/nous_billing.py`：`/api/billing/state`、`/api/billing/charge`、`/api/billing/charge/{id}`、`/api/billing/auto-top-up`、`/api/billing/subscription`、`/api/billing/subscription/preview`、`/api/billing/subscription/pending-change`、`/api/billing/subscription/upgrade` |

## 三、对我们意味着什么（三条路）

**A. 搭上游账号体系**：用户登录 Nous 账号（或走免费层 `nous/welcome`）。
- 成本最低（核心已实现全部链路），但我们**不变现**，且产品体验受上游可用性/额度影响；用户在国内访问 `portal.nousresearch.com` 的连通性未验证。
- 适合当"附加选项"（愿意用官方额度的用户），不适合当商业底座。

**B. 自建"门户兼容后端"**（推荐作为二期首选评估项）
- 核心侧**零改动**：把 `HERMES_PORTAL_BASE_URL` 指到我们自己的服务端即可。
- 服务端要实现：上表 8 个 `/api/billing/*` 端点 + 一套 token 签发/校验（对应核心的 `resolve_nous_access_token`）。
- 前端（账单页、套餐页、充值流程）可以直接复用核心已经返回的字段（`balance_usd`、`charge_presets`、`tiers`、`monthly_cap`、`auto_reload`…），省掉一整层自研 UI。
- **未验证**：核心登录链（provider `nous` 的 auth 流程）具体怎么拿 token（OAuth 设备流？PAT？），以及核心对返回字段的全部校验规则 —— 要真正落地需要先做一次端到端联调。

**C. 壳侧完全自建**（一期现状）
- 一期就是"用户自带 key"，不涉及账号/计费；等有明确付费场景再选 A 或 B。
- 若选 C，**不要**去动核心的 billing 方法，避免与上游语义冲突。

**拍板建议**：一期维持 C（自带 key）；二期在 A 与 B 之间做一次 1–2 天的技术验证（先验证 B 的最小闭环：把门户指到本地 mock，看核心是否正常读账单/下单），再决定。**不要在验证前承诺"我们能做自己的计费闭环"。**

---

## 四、"门户兼容后端"最小验证：**已跑通**（2026-09-16）

问题：选项 B（自建门户兼容后端）到底可不可行？——**可行，且核心零改动**。以下是实测。

**做法**（全部本机、不联网）：
1. `scripts/dev/mock-portal.mjs`——实现那 8 个 `/api/billing/*` 端点，并给每个请求打日志；
2. 造一个隔离的 `HERMES_HOME/auth.json`，写入 provider `nous` 的本地 token：
   ```json
   { "active_provider": "nous",
     "providers": { "nous": { "access_token": "local-token-abc123", "refresh_token": "local-refresh",
                              "token_type": "Bearer", "scope": "billing:manage",
                              "expires_at": "<30 天后的 ISO 时间>", "client_id": "local-client" } } }
   ```
   （`expires_at` 是 **ISO 时间戳**；放远一点就走"未过期直接用"的快路径，不触发 refresh。）
3. 用 `HERMES_PORTAL_BASE_URL=http://127.0.0.1:8799` 起核心；
4. `scripts/dev/portal-spike.mjs` 依次调用 `billing.state / subscription.state / usage.bars / billing.charge / billing.charge_status`。

**实测结果（5/5 通过，`npm run portal:spike`）**：

```
✓ billing.state 读到我们门户的余额 — logged_in=true balance=$42.50 org=本地门户（mock） can_charge=true
✓ subscription.state 读到我们门户的套餐表 — current=plus tiers=[free,plus(当前),pro] can_change_plan=false
✓ usage.bars 有读数 — {"ok":true,"available":true,...}
✓ billing.charge 下单（写操作走我们门户） — {"ok":true,"charge_id":"ch_local_1","idempotency_key":"589133b7-…"}
✓ billing.charge_status 查询订单 — {"ok":true,"status":"succeeded","amount_usd":"10"}

mock 门户收到 4 个 /api/billing/* 请求（带我们的本地 token）：
   GET  /api/billing/state
   GET  /api/billing/subscription
   POST /api/billing/charge                       idem=589133b7-…
   GET  /api/billing/charge/ch_local_1
```

**由此确定的事实**：

| 事项 | 结论 |
|---|---|
| 门户地址 | `HERMES_PORTAL_BASE_URL` / `NOUS_PORTAL_BASE_URL` 是**最高优先级**的运维开关（`hermes_cli/auth.py:1599-1606`），绕过 host 白名单 → 指到我们自己的域名即可 |
| 要实现的接口 | 就是那 8 个 `/api/billing/*`（state / charge / charge/{id} / auto-top-up / subscription / subscription-preview / pending-change / upgrade）；写操作带 `Idempotency-Key` |
| 响应字段名 | `state`：`balanceUsd`(字符串金额)/`cliBillingEnabled`/`chargePresets`/`minUsd`/`maxUsd`/`org{id,slug,name}`/`role`/`card{brand,last4}`/`monthlyCap`/`autoReload`/`portalUrl`；`subscription`：`current{tierId,tierName,…}` + `tiers[]{tierId,name,tierOrder,isCurrent,isEnabled,dollarsPerMonthDisplay,monthlyCredits}`（**tiers 里是 `name` 不是 `tierName`**，实测踩过一次） |
| 身份 | 核心读 `HERMES_HOME/auth.json` 里 provider `nous` 的 `access_token`（ISO `expires_at` + `scope` 里要有 `billing:manage`，否则核心会跳过注定 403 的写操作） |
| 前端 | 账单/套餐页可以直接复用核心返回的字段（余额、套餐表、用量条），**不用自研这一层 UI** |

**还没验证的一件事（下一步的关键）**：**登录链**——本次是把 token 直接写进 `auth.json` 绕过了登录。
真实产品需要"用户在我们这边登录 → 拿到 token → 写进 `auth.json`（或让核心走 OAuth 设备流打我们的端点）"。
工作量集中在服务端（签发 + 校验 + 刷新），可选两条路：
① 壳侧登录（我们自己走自己的 OAuth/验证码，登录成功后由壳写 `auth.json` 的 `nous` 段）——**最省事，不碰核心**；
② 实现核心期望的 OAuth 设备流端点（让核心自己去登录我们的服务端）——更"原生"，但要逆向门户的 OAuth 契约。

**对商业化的建议**：二期选 ①。它把"账号/额度"收在我们自己的服务端，核心只当"显示与下单的通道"；
且这条路已经用 5/5 的实测证明"核心侧不需要任何修改"。

