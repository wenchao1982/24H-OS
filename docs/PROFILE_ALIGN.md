# 官方 Profile 对齐（M9）

> **一个 Hermes profile = 一个 agent（Bot）。** 工作台的身份 / 配置读写对齐到官方
> Profile 原语（`profiles.*` RPC），不再把描述 / 启停状态当作自研字段。
>
> 内核版本：**Hermes v0.21.3**。契约来源（只读参考）：
> `~/hermes-desktop/home/hermes-agent/tui_gateway/contracts/profiles_vault_complete_foreign_subagents.py`
> 与 `.../tui_gateway/methods_profiles.py`。

## 1. 官方 Profile 原语

| RPC | 参数 | 结果要点 |
| --- | --- | --- |
| `profiles.list` | `include_sessions?` | roster：`name/path/is_default/model/provider/description/display_name/skill_count/has_avatar` + `bot_mode_protocol` |
| `profiles.create` | `name, description?, clone_from?, clone_all?, clone_channels?, no_skills?, no_alias?, soul?, model?, provider?, share_auth?, mirror_credentials?` | `soul_written` / `model_set` / `mirrored` |
| `profiles.describe` | `name` | `{soul, description, model:{provider,default}, skills:[{name,enabled}], toolsets, mcp_servers}` |
| `profiles.configure` | `name, ui_meta?, ui_meta_expected_revisions?, soul?, description?, model?, provider?, confirm_expensive_model?, disabled_skills?, enabled_toolsets?, enabled_mcp_servers?` | `{ok, applied:{...}, confirm_required?, confirm_message?}` |
| `profiles.set_asset` | `name, asset:"avatar", data`（data URL / base64，PNG/JPEG/WebP ≤2MB，魔数嗅探） | `{ok, asset, size, removed?}` |
| `profiles.get_asset` | `name, asset:"avatar"` | `{found, mime?, size?, data?}`（缺失是 `found:false`，非错误） |

薄封装：`server/hermes/profileRpc.ts`（风格对齐 `server/hermes/cron.ts`）。新增错误码：
`PROFILE_RPC_ERROR`(502) / `PROFILE_NOT_FOUND`(404) / `INVALID_ASSET`(400)。

## 2. 落盘位置

| 字段 | 官方落盘 | 说明 |
| --- | --- | --- |
| `soul`（persona 正文） | `$HERMES_HOME[/profiles/<name>]/SOUL.md` | 官方 writer：`profiles.configure {soul}` / `profiles.create {soul}` |
| `description`（短描述） | `<profileDir>/profile.yaml` 的 `description` | 官方 `write_profile_meta` |
| `disabled_skills` | `<profileDir>/config.yaml` 的 `skills.disabled` | 官方 `save_disabled_skills` |
| 头像 | `<profileDir>/assets/avatar.<png\|jpg\|webp>` | 单文件、原子替换 |
| `ui_meta`（工作台 UI 状态） | `<profileDir>/profile.yaml` 的 `ui_meta` + `_ui_meta_revisions` | per-key CAS，见 §5 |

## 3. 读 / 写路径与 `via` 语义

### 描述 / persona

- **读**（列表 `GET /api/agents`、详情、`GET /api/agents/:id/config`）优先级：
  官方 `profile.yaml description` → 官方 `SOUL.md` 摘要（首个正文段落，≤240 字）→
  工作台 `meta.json.description` → config 派生描述。
  `AgentConfig.soul` 直接返回完整 SOUL.md 正文。
- **写**（`PATCH /api/agents/:id/config`）：
  - `soul` → 官方优先 `profiles.configure {soul}`（**复用已连接的共享 gateway**）；
    RPC 不可用 / 失败 → 回退写 `<profileDir>/SOUL.md`（备份 + 原子写）。
  - `description` → 官方优先 `profiles.configure {description}`；失败回退 `meta.json`。
  - `tags` → 恒写 `meta.json`（Hermes 无此字段）。
- **`via`**（`ConfigEditResult.via`）：`"rpc"` = 走官方 Profile RPC；`"cli"` = 走官方
  `hermes config` CLI（模型 / MCP / env）；`"file"` = 官方通道不可用，回退文件写。
  前端在保存提示里展示「通道：官方 RPC / 官方 CLI / 文件回退」。

> **不额外 spawn gateway**：配置读写的官方路径只复用**已经连接**的共享 gateway
> （用户打开 chat / cron 时惰性拉起）。未运行时直接走文件回退——因为文件回退写的就是
> 官方同款 artifact（SOUL.md / 官方 config.yaml），语义一致。

### skill 启停

- **读**：`server/skillui/disabled.ts` → `configEdit#listDisabledSkillNames`。
  官方 `config.yaml skills.disabled` 优先（能确定 home 时读取：显式 `deps.hermesHome`
  或 `OS_HERMES_HOME`/`HERMES_HOME`，否则用服务端探测到的 activeHome），官方已管理的
  agent 忽略 `meta.json`；其余回退 meta。与 `GET /api/skill-uis` 的 `disabled`
  **同口径**（大小写不敏感，命中 id / 目录名）。
- **写**（`POST /api/agents/:id/skills {name, enabled, confirm}`）：
  官方优先 `profiles.configure {disabled_skills}`（替换语义）；RPC 不可用 → 回退
  `meta.json` 的 `skills.<name>.enabled`（保留 M2 杂项行为）。`via:"rpc"|"file"`。

### 头像（M9 新增）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agents/:id/avatar` | 转发 `profiles.get_asset`；未设置 `{found:false}` |
| POST | `/api/agents/:id/avatar` | `{data, confirm:true}`；**工作台限制 PNG/JPEG ≤256KB**（官方 2MB），魔数嗅探后转发 `profiles.set_asset` |

前端：Agent 详情页展示头像（无则回退首字母），「换头像」按钮选择本地 PNG/JPEG 上传。

## 4. `meta.json` 的新定位（降级为「24H-OS 专有备注」）

`~/.24os/agents/<id>/meta.json` 不再是描述 / 启停的主数据源，降级为：

- `tags`（Hermes 无对应字段）；
- 官方 RPC 不可用时的 `description` / `skills` **回退副本**。

迁移（幂等，无需用户操作）：

- 原 `meta.description` → 在能连官方 gateway 时经 `profiles.configure {description}` /
  `{soul}` 迁移到 `profile.yaml` / `SOUL.md`；随后读取以官方为准。
- 原 `meta.skills.<name>.enabled=false` → 经 `profiles.configure {disabled_skills}`
  迁到 `config.yaml skills.disabled`；读取以官方为准（官方已管理该 agent 时 meta 被忽略）。
- 迁移前旧数据仍可读（回退路径），不会丢失。

## 5. `ui_meta` CAS（官方 compare-and-swap）

`profiles.configure` 的 `ui_meta_expected_revisions` 是 per-key CAS：客户端带上次读到的
revision，任一 key 不匹配则**整笔拒绝**并在 `applied.ui_meta_conflicts` 报告
`{expected, actual}`；revision 在删除后仍保留，防止陈旧客户端重建已删 key。
工作台 UI 状态（如折叠 / 排序）如未来落到 `ui_meta`，须遵守该 CAS 语义。

## 6. 测试 / 验证

- 单测：`server/hermes/profileRpc.test.ts`（方法映射 / 错误归一 / 头像校验）、
  `server/hermes/configEdit.test.ts`（官方优先 + 文件回退）、
  `server/skillui/disabled.test.ts`（官方 disabled_skills 优先）、
  `server/routes/agentsProfile.test.ts`（头像 confirm / 大小 / 类型）、
  web `AgentConfigEditor` / `AgentDetail` / `api` 用例。
- 全部用临时目录 / 注入 client，**绝不触碰真实 `~/.hermes`**、不连真实 gateway。
- 冒烟：隔离 `HERMES_HOME` + 真实 `hermes serve`（见 §7）。

## 7. 实测结论（本机 Hermes v0.21.3，隔离 `HERMES_HOME`）

| RPC | 可用 | 备注 |
| --- | --- | --- |
| `profiles.list` | ✅ | 经工作台 API 返回 roster + `bot_mode_protocol` |
| `profiles.create` | ✅ | 创建测试 profile（`soul_written:true`） |
| `profiles.describe` | ✅ | 读回 `soul` / `disabled_skills` |
| `profiles.configure`（soul / description / disabled_skills） | ✅ | 写回并读回一致 |
| `profiles.get_asset` / `set_asset` | ✅ | 1×1 PNG 上传 / 读取 |
| 删除测试 profile | ✅ | 直接删除隔离 home 内目录；`~/.hermes`、`~/hermes-desktop/home` 未写入、无残留进程 |

> 若某 RPC 在特定部署不可用，工作台按上文**回退文件写**或如实报错，不伪装成功。
