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
