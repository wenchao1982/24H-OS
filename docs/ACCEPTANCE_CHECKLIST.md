# 24H-OS 真机验收清单（中文 · 可逐项打勾）

> 面向**有显示器、有真实 Hermes 环境**的验收人。每一项都给出 **前置 / 步骤（可复制命令）/ 期望 / 失败时收集什么**。
> 所有命令与**当前实现**一致（基线：`npm run check` = **533** 用例 + 3 套 typecheck 全绿）。
>
> 图例：
> - ✅ 通过标准（必须满足的**具体**期望值，不是「应该正常」）。
> - ⚠️ 风险：会产生**费用** / 触碰**真实数据** / **不可逆**操作，执行前先读。
> - ❌ 失败：对应「失败时收集什么」里的证据一并提交（见 [§12 反馈模板](#12-反馈模板)）。

---

## 约定与变量

后续命令默认使用以下变量，**先执行一次**（按你的环境改）：

```bash
# API 基址：dev 模式 server 固定 4319；生产式 `npm start` 也是 4319。
export BASE="http://127.0.0.1:4319"
# 你要验收的 profile（Agent id）。
export AGENT="main"
# Hermes 主目录（默认 ~/.hermes；若用 Studio/多 home，改这里）。
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
# Agent 的 profile 目录（id=default 时为 HERMES_HOME 本身）。
export PROFILE_DIR="$HERMES_HOME/profiles/$AGENT"
[ "$AGENT" = "default" ] && export PROFILE_DIR="$HERMES_HOME"
# 工作台元数据 / 备份根。
export META_DIR="${OS_META_DIR:-$HOME/.24os/agents}"
export BACKUP_DIR="${OS_BACKUP_DIR:-$HOME/.24os/backups}"
```

> 命令里用到 `jq` 做美化；若未安装，用 `python3 -m json.tool` 代替，或直接 `curl -s ...` 肉眼看 JSON。
> 浏览器侧：dev 打开 **http://localhost:5173**；生产式/Electron 打开 **http://127.0.0.1:4319**。

---

## §0 前置准备（务必先做）

### 0.1 备份真实环境并记录基线

**前置**：你已有真实的 `~/.hermes`（可能含生产 profile）。⚠️ **备份前不要做任何写入实验。**

**步骤**

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$HOME/24os-acceptance-backup/$STAMP"
mkdir -p "$DEST"
# 逐个打包存在的目录（不存在则跳过，不报错）
tar czf "$DEST/hermes.tar.gz"          -C "$HOME" .hermes                 2>/dev/null || true
tar czf "$DEST/hermes-desktop.tar.gz"  -C "$HOME" hermes-desktop/home    2>/dev/null || true
tar czf "$DEST/24os.tar.gz"            -C "$HOME" .24os                  2>/dev/null || true
# 校验清单 + 立即验证可读
sha256sum "$DEST"/*.tar.gz | tee "$DEST/SHA256SUMS"
sha256sum -c "$DEST/SHA256SUMS"
# 打一个「基线时间戳」标记，用于之后查找被改动的文件
touch "$DEST/marker"
echo "备份目录：$DEST"
```

改动后对比基线（列出被新建/修改的文件）：

```bash
find "$HERMES_HOME" "$META_DIR" "$BACKUP_DIR" -type f -newer "$DEST/marker" -print 2>/dev/null
```

**期望**
- `sha256sum -c` 全部输出 `OK`；
- `$DEST` 下至少有 `hermes.tar.gz`（若你的环境确实有 `~/.hermes`），并存在 `marker`。

**失败时收集什么**：`ls -la "$DEST"`、`sha256sum -c` 的报错行、`df -h "$HOME"`（空间不足时 tar 会截断）。

> ⚠️ **不要拿 `~/.hermes`（Hermes Studio 的生产部署）做破坏性实验**（安装 / 卸载 / 删除 profile / 改模型）。
> 请新建一个**一次性 profile**（如 `AGENT=acc-test`），或指向独立的 `HERMES_HOME`：
> `export HERMES_HOME="$HOME/.hermes-acc"`（先 `mkdir -p "$HERMES_HOME"`），验收完整体删除。

### 0.2 环境检查

**前置**：已 `npm install`。

**步骤**

```bash
node -v                       # 期望 v20+（本项目在 v23 验证）
hermes --version              # 期望打印 Hermes 版本号
npm run check                 # 期望 533 passed + 3 套 tsc 无错误
```

**期望**
- `node -v` → `v20.x` 或更高；
- `hermes --version` → 输出版本（非「command not found」）；
- `npm run check` → 末尾 `Tests  533 passed`，且 `tsc` 三套无输出错误。

**失败时收集什么**：三条命令的**完整** stdout+stderr、`node -v`、`which hermes`。

### 0.3 选择启动方式

**前置**：§0.2 环境检查通过。

**步骤**：按下表任选一种方式启动。

| 方式 | 命令 | 访问地址 | 适用 |
| --- | --- | --- | --- |
| 开发 | `npm run dev` | http://localhost:5173 | 日常 UI 验收（server 4319 + Vite 5173） |
| 生产式 | `npm run build && npm start` | http://127.0.0.1:4319 | 验证静态托管 / 单端口 |
| 桌面 | `npm run build && npm run electron` | Electron 窗口 | 窗口 / 打包验收（有显示器） |
| 安装包 | `npm run dist` → 运行 `release/*.AppImage` 或 `sudo dpkg -i release/*.deb` | Electron 窗口 | 分发验收 |

**期望**：启动日志出现 `24H-OS server 已启动：http://127.0.0.1:4319`；`curl -s $BASE/api/health` → `{"ok":true,"service":"24h-os-server"}`。

**失败时收集什么**：启动终端完整日志、`lsof -i :4319`、`ps -ef | grep -E 'tsx|server.cjs'`。

---

## §1 基础加载与状态

### 1.1 页面与标题

**前置**：server + web 已启动（§0.3 方式一或二）。

**步骤**：浏览器打开对应地址。

**期望**
- 页面 `<title>` = **`24H-OS · Hermes 多 agent 工作台`**；
- 顶部状态条显示 **`Hermes 已连接`**，且右侧为 **`LIVE 数据`**（无真实 Hermes 时才显示 `未连接` / `MOCK 数据`）；
- 左侧有 4 个 Tab：**Agents**、**Skill**、**Agent 市场**、**定时**。

**失败时收集什么**：截图、浏览器 console 全部 error、`curl -s $BASE/api/agents | head -c 500`。

### 1.2 console 无 error

**前置**：页面已加载（§1.1）。

**步骤**：打开开发者工具 → Console，刷新页面。

**期望**：无红色 `error`（允许 warning）。特别是无 `Failed to fetch`、`WebSocket connection failed`。

**失败时收集什么**：Console 截图/文本、Network 面板中失败请求的 URL 与状态码。

### 1.3 状态抽屉 WS「已连接」

**前置**：打开任一页面（Dashboard WS 默认随页面连接）。

**步骤**：点击打开「状态抽屉」（Dashboard / 连接状态入口）。

**期望**
- 连接状态显示 **`已连接`**（进入瞬间可能是 `连接中`）；
- 收到 hello / 事件摘要；`curl -s $BASE/api/hooks/log` 正常返回。

**失败时收集什么**：抽屉截图、`curl -s http://127.0.0.1:4319/api/health`、server 日志中 `Dashboard WS 已挂载` 行。

---

## §2 只读冒烟（先跑脚本）

**前置**：server 正在运行（任意方式）。

**步骤**

```bash
node scripts/acceptance-smoke.mjs
# 或指定地址：
node scripts/acceptance-smoke.mjs --base http://127.0.0.1:4319
OS_E2E_BASE=http://127.0.0.1:4319 node scripts/acceptance-smoke.mjs
```

该脚本**只发 HTTP GET**（零写入、零模型调用、不触碰 `~/.hermes` / `~/.24os`），逐项打印 `PASS/FAIL/SKIP`。

**期望**：全部 `PASS`，退出码 `0`。检查项与期望值：

| 检查项 | HTTP | 期望摘要 |
| --- | --- | --- |
| `GET /api/health` | 200 | `ok=true service=24h-os-server` |
| `GET /api/agents` | 200 | `agents=<你的 profile 数> mode=live` |
| `GET /api/agents/:id` | 200 | id 与请求一致，`model=... skills=N mcp=M` |
| `GET /api/agents/:id/config` | 200 | `envKeys=[...]` **仅键名**，无 `env/values` 明文对象 |
| `GET /api/skill-uis` | 200 | 含 `ppt`、`outline` |
| `GET /api/market` | 200 | 默认 5 条（含 2 个 AppManifest） |
| `GET /api/cron/jobs` | 200 | 与 `hermes cron list` 一致；`ticker.enabled=true` |
| `GET /api/hermes/subagents` | 200 | `spawnApi=false controlApi=true events=true` |
| `GET /api/hooks/log` | 200 | `entries=... total=...` |
| `GET /` | 200 | 已构建 → HTML；纯 API → 24H-OS 自述 JSON |
| `GET /skill-ui/outline/panel.yaml` | 200 | `protocol: 24os-skill-panel/1` |
| `no-secret-echo`（聚合） | - | 所有响应未见 `api_key`/`token`/`secret` 明文值 |

实现细节提示：声明式面板的静态根是 `<skill>/ui`，因此 URL 是 **`/skill-ui/outline/panel.yaml`**（不是 `/skill-ui/outline/ui/panel.yaml`）。

**已知会 FAIL 的合理场景（不要放宽断言）**
- `/api/cron/jobs` 返回 **503 `GATEWAY_UNAVAILABLE`**：共享 gateway 尚未拉起（无真实 CLI / 首次访问前）。
  处理：先访问一次 UI，或 `curl -s -X POST $BASE/api/hermes/gateway/start`，再重跑脚本。
- 无真实 Hermes CLI 的隔离环境：cron 必然 503，脚本退出码 1 属**预期**（脚本刻意不为「全绿」而弱化断言）。

**失败时收集什么**：脚本完整输出、失败的 `curl -sv <URL>`（含响应头/体）、server 日志对应片段。

---

## §3 Agent = Profile（官方 `profiles.*` 对齐）

### 3.1 列表 / 详情

**前置**：`AGENT`/`BASE` 已设置。

**步骤**

```bash
curl -s "$BASE/api/agents" | jq '{mode:.status.mode, ids:[.agents[].id]}'
curl -s "$BASE/api/agents/$AGENT" | jq '{id,model,skills:[.skills[]|{id,enabled,hasUi,uiId}],mcp:[.mcpServers[].name],tags}'
curl -s "$BASE/api/agents/$AGENT/config" | jq '{model,soul:(.soul|length),tags,envKeys,mcp:[.mcpServers[].name],configPath,envPath}'
```

**期望**
- `status.mode` = `live`（真实环境）；列表 id 与 `ls "$HERMES_HOME/profiles"` 一致（外加 `default` 若有）；
- 详情 `model` 非空、`skills[]` 含官方启停状态（`enabled` 布尔）、自带 UI 的 skill 有 `hasUi:true` 与 `uiId`；
- `config.envKeys` 是字符串数组（**只有键名**），响应中**不含任何 env 明文值**。

**失败时收集什么**：三条命令原始输出、`ls "$HERMES_HOME/profiles"`、脱敏后的 `$PROFILE_DIR/config.yaml`。

### 3.2 头像：GET / POST

**前置**：准备一张 ≤256KB 的 PNG/JPEG。下面用内联 1×1 PNG（70 bytes）复现。
头像走官方 `profiles.get_asset` / `profiles.set_asset`，**需要共享 gateway（真实 Hermes）**；gateway 不可用时返回 **503 `GATEWAY_UNAVAILABLE`**（不会静默改文件）。

**步骤**

```bash
# 查询当前头像（未设置 → found:false）
curl -s "$BASE/api/agents/$AGENT/avatar" | jq

# 上传（⚠️ 会写入 $PROFILE_DIR/assets/avatar.*）
PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
curl -s -X POST "$BASE/api/agents/$AGENT/avatar" \
  -H 'content-type: application/json' \
  -d "{\"data\":\"data:image/png;base64,$PNG_B64\",\"confirm\":true}" | jq

# 再次查询（应 found:true）
curl -s "$BASE/api/agents/$AGENT/avatar" | jq '{found,mime,size}'

# 反向：缺 confirm → 400 CONFIRM_REQUIRED（不落盘）
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/agents/$AGENT/avatar" \
  -H 'content-type: application/json' -d "{\"data\":\"data:image/png;base64,$PNG_B64\"}"
```

**期望**
- 上传成功：`{"ok":true,"size":70,"message":"头像已更新（image/png，70 bytes）。"}`；
- 再次 GET：`found:true`、`mime:"image/png"`、`size:70`、`data` 为 `data:image/png;base64,...`；
- 缺 `confirm` → HTTP **400**，body `{"error":"CONFIRM_REQUIRED",...}`，且 `$PROFILE_DIR/assets/` 无新文件；
- 非 PNG/JPEG 或 >256KB → HTTP **400** `INVALID_ASSET`。

**失败时收集什么**：命令原始输出、`ls -la "$PROFILE_DIR/assets"`、浏览器中头像是否刷新（换 agent 再回来看）。

### 3.3 编辑 SOUL（persona）→ `via` → 备份

**前置**：`AGENT` 指向一个**测试用** profile（见 §0.1 警告）。

**步骤**

```bash
curl -s -X PATCH "$BASE/api/agents/$AGENT/config" \
  -H 'content-type: application/json' \
  -d '{"soul":"你是 24H-OS 验收测试人格：回答简洁。","confirm":true}' | jq

# 验证落盘（SOUL.md 是官方 persona 文件）
cat "$PROFILE_DIR/SOUL.md"
# 备份（via:"file" 时才会有；via:"rpc" 由官方写入，files 为空但磁盘已变）
ls -lt "$BACKUP_DIR/$AGENT" 2>/dev/null | head
```

**期望**
- 返回 `{"ok":true,"action":"update-config","via":"rpc"|"file", ...}`；
- `via:"rpc"` = 走官方 `profiles.configure {soul}`（官方 gateway 已连接时）；`via:"file"` = 回退文件写；
- `cat "$PROFILE_DIR/SOUL.md"` 内容包含刚提交的一段话；
- `via:"file"`：首次创建 `SOUL.md` 时无备份（`backups:[]`）；**`SOUL.md` 原本已存在**时 `$BACKUP_DIR/$AGENT` 下新增 `<SOUL.md>.<时间戳>.bak`；
- `via:"rpc"`：`files:[]`（官方直写，`backups:[]`）。

**失败时收集什么**：PATCH 响应、`cat "$PROFILE_DIR/SOUL.md"`、`ls -la "$PROFILE_DIR" "$BACKUP_DIR/$AGENT"`、server 日志。

### 3.4 模型切换（+ 昂贵模型确认在 §6）

**前置**：`AGENT` 指向测试 profile；已知一个合法模型名（如 `kimi-k2.5`）。

**步骤**

```bash
curl -s -X PATCH "$BASE/api/agents/$AGENT/config" \
  -H 'content-type: application/json' \
  -d '{"model":"kimi-k2.5","confirm":true}' | jq
grep -n "^model" "$PROFILE_DIR/config.yaml"
```

**期望**
- 返回 `{"ok":true,"action":"update-config","via":"cli"|"file"}`；
- `config.yaml` 的 `model:`（或 `model.default:`）变为 `kimi-k2.5`；`model` 下的其它子字段（如 `provider`）保留；
- 缺 `confirm` → 400 `CONFIRM_REQUIRED`。

**失败时收集什么**：响应、修改前后的 `config.yaml` 片段、`hermes --version`。

### 3.5 Skill 启停（官方 `disabled_skills`）+ 三路 403

**前置**：`$AGENT` 的 skills 列表里确实有 `ppt`（即该 profile 能发现 `ppt` skill）。
否则返回 **400 `INVALID_SKILL`**（不会误写）。可用 `curl -s "$BASE/api/agents/$AGENT" | jq '[.skills[].id]'` 确认。

**步骤**

```bash
# 禁用 ppt
curl -s -X POST "$BASE/api/agents/$AGENT/skills" \
  -H 'content-type: application/json' \
  -d '{"name":"ppt","enabled":false,"confirm":true}' | jq

# 验证落盘：via:"rpc" → 官方 config.yaml；via:"file" → 工作台 meta.json
grep -n -A3 "^skills" "$PROFILE_DIR/config.yaml"
cat "$META_DIR/$AGENT/meta.json" 2>/dev/null

# 列表应标 disabled:true
curl -s "$BASE/api/skill-uis" | jq '.[]|[.id,.disabled]'
# 三路拦截：静态 / 声明式面板 / broker
curl -s -o /dev/null -w 'static=%{http_code}\n' "$BASE/skill-ui/ppt/index.html"
curl -s -o /dev/null -w 'panel=%{http_code}\n'  "$BASE/skill-uis/ppt/panel"
curl -s -o /dev/null -w 'invoke=%{http_code}\n' -X POST "$BASE/api/skill-host/invoke" \
  -H 'content-type: application/json' -d '{"skillId":"ppt","method":"runTool","params":{"tool":"ppt.export"}}'

# 复原
curl -s -X POST "$BASE/api/agents/$AGENT/skills" \
  -H 'content-type: application/json' \
  -d '{"name":"ppt","enabled":true,"confirm":true}' | jq
```

**期望**
- 禁用返回 `{"ok":true,"action":"set-skill","via":"rpc"|"file"}`；
  - `via:"rpc"`：`$PROFILE_DIR/config.yaml` 出现 `skills.disabled: [ppt]`；
  - `via:"file"`：`$META_DIR/$AGENT/meta.json` 的 `skills.ppt.enabled = false`；
- 列表该 skill `disabled:true`（`disabled` 字段只在禁用时出现；未禁用时字段缺省，而非 `false`）；UI 中该 skill 显示 **`已禁用`** 且**打开入口消失**；
- 三路均 **403**，body `{"error":"SKILL_DISABLED",...}`；
- 复原后该 skill 不再带 `disabled` 字段，入口恢复。

**失败时收集什么**：各命令输出、`config.yaml` / `meta.json` 脱敏片段、浏览器截图。

---

## §4 市场 / AppManifest

**前置**：`BASE`；市场清单 `market/index.json` 与 `market/apps/*.app.yaml` 存在。

### 4.1 列表（5 条）

**前置**：`market/index.json` 与 `market/apps/*.app.yaml` 已随仓库就位。

**步骤**

```bash
curl -s "$BASE/api/market" | jq '{count:(.entries|length), entries:[.entries[]|{id,version,appManifest}]}'
curl -s "$BASE/api/market/apps/ppt-maker" | jq '{protocol,id,name,version,ui,hooks}'
```

**期望**：`count=5`（3 条来自 `index.json` + 2 个 AppManifest：`ppt-maker`、`outline-declarative`）；`ppt-maker` 的 `protocol=24os-appmanifest/1`、`ui.host=iframe`、`hooks.oninstall=["ui.open"]`；`GET /api/market/apps/<不存在>` → 404 `APP_NOT_FOUND`。

**失败时收集什么**：两条命令输出、`ls market/apps`、`cat market/index.json`。

### 4.2 安装 `ppt-maker`（confirm 门禁）

**前置**：在测试 profile 环境执行。⚠️ 本操作会创建/改动 profile 并可能调用 `hermes profile install`。

**步骤**

```bash
APPS_DIR="${OS_APPS_DIR:-$HOME/.24os/apps}"
# 无 confirm → 400，不落盘
curl -s -X POST "$BASE/api/market/ppt-maker/apply" \
  -H 'content-type: application/json' -d '{"mode":"install"}' | jq
ls "$APPS_DIR/ppt-maker.json" 2>/dev/null || echo "记录未创建（符合预期）"

# 有 confirm → 安装
curl -s -X POST "$BASE/api/market/ppt-maker/apply" \
  -H 'content-type: application/json' \
  -d '{"mode":"install","confirm":true}' | jq '{ok,mode,id,version,hooks,steps,backups,message}'
```

**期望**
- 无 `confirm` → **400** `{"error":"CONFIRM_REQUIRED",...}`，且 `~/.24os/apps/ppt-maker.json` **不存在**；
- 有 `confirm` → `ok:true`、`mode:"install"`、`id:"ppt-maker"`、`version:"1.0.0"`、`hooks:["ui.open"]`；`steps` 含 profile 创建 / 模型 `kimi-k2.5` / MCP `filesystem` / skill `ppt` 复制等；
- 落盘证据：
  - profile 目录 `$HERMES_HOME/profiles/ppt-maker` 存在（或按模板建立）；
  - skill 复制到 `$HERMES_HOME/skills/ppt`；
  - 安装记录写在 `${OS_APPS_DIR:-$HOME/.24os/apps}/ppt-maker.json`，且 `manifest.profile.env` 的值**要么为空、要么为 `***`**（**绝不出现明文**；内置 `ppt-maker` 声明的 `MY_API_KEY: ""` 故显示为空字符串）。

```bash
jq '.' "$APPS_DIR/ppt-maker.json"
grep -n "MY_API_KEY" "$APPS_DIR/ppt-maker.json"   # 只应见键名 + 空值/***
```

**失败时收集什么**：响应、`~/.24os/apps/ppt-maker.json`（脱敏后）、`ls -R "$HERMES_HOME/profiles/ppt-maker"`、server 日志。

### 4.3 卸载（先备份）与回滚

**前置**：已按 §4.2 安装 `ppt-maker`（回滚还需至少一次 `update` 产生历史版本）。

**步骤**

```bash
# 回滚前置：先 install → update → rollback
curl -s -X POST "$BASE/api/market/ppt-maker/apply" -H 'content-type: application/json' -d '{"mode":"update","confirm":true}' | jq '{mode,version,backups,history:(.steps|length)}'
curl -s -X POST "$BASE/api/market/ppt-maker/apply" -H 'content-type: application/json' -d '{"mode":"rollback","confirm":true}' | jq '{ok,mode,version,backups,message}'
# 卸载（删除前自动备份 profile 到 $BACKUP_DIR）
curl -s -X POST "$BASE/api/market/ppt-maker/apply" -H 'content-type: application/json' -d '{"mode":"uninstall","confirm":true}' | jq '{ok,mode,backups,steps,message}'
```

**期望**
- `update` → `steps` 含 `已备份 profile：...`，`backups` 非空；
- `rollback` → `ok:true`、`version` 为上一版、`backups` 指向备份文件；
- `uninstall` → `backups` 非空（删除前备份），profile 目录被删除、`~/.24os/apps/ppt-maker.json` 被移除；
- 所有 mode 缺 `confirm` → 400 `CONFIRM_REQUIRED`。

**失败时收集什么**：各响应、`ls -lt "$BACKUP_DIR"`、`ls "$HOME/.24os/apps"`。

---

## §5 Skill UI 双形态

**前置**：`examples/skills/{ppt,outline}` 在扫描根内（默认含仓库 `examples/skills`）。

### 5.1 命令式 iframe：`ppt`

**前置**：`ppt` 未被禁用（§3.5 复原后）。

**步骤**
1. UI：Agents → 选中 agent → 找到 `ppt`（`hasUi:true`）→ 打开；
2. 或直接访问 `curl -s "$BASE/api/skill-uis/ppt" | jq '{id,uiHost,manifest}'`。

**期望**
- `GET /api/skill-uis/ppt` → `uiHost:"iframe"`，`manifest.protocol="24os-skill-ui/1"`，`capabilities` 含 `chatStream`/`runTool` 等；
- iframe 加载 `http://127.0.0.1:4319/skill-ui/ppt/index.html`（严格 CSP），完成 `host.init` 握手；
- 模板画廊可见；点击「生成 PPTX」→ 经 broker `runTool:ppt.export` 生成**非空 .pptx**，可下载/打开；
- RPC 调试面板可看到请求/响应与 sessionNonce。

**失败时收集什么**：iframe 截图、console error、`curl -s "$BASE/api/skill-uis/ppt"`、`curl -sI "$BASE/skill-ui/ppt/index.html"`。

### 5.2 声明式：`outline`（零代码 / 无任意 JS）

**前置**：`outline` 未被禁用。

**步骤**

```bash
curl -s "$BASE/api/skill-uis/outline" | jq '{id,uiHost,skill:(.panel.skill),fields:[.panel.fields[].key],actions:[.panel.actions[].id]}'
curl -s "$BASE/api/skill-uis/outline/panel" | jq '.protocol'
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/skill-ui/outline/panel.yaml"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/skill-ui/outline/templates/index.json"
```

**期望**
- `uiHost:"declarative"`，`panel.protocol="24os-skill-panel/1"`，含字段与动作；
- `panel.yaml` / `templates/index.json` 均 **200**（扩展名白名单含 `.yaml`/`.json`）；
- UI 渲染表单（text/textarea/select/slider/file）、模板画廊；`{{key}}` 插值后触发 SSE。

**失败时收集什么**：命令输出、`curl -s "$BASE/api/skill-uis/outline/panel"`、UI 截图。

---

## §6 真实模型与交互式审批（⚠️ 首次产生费用）

⚠️ **本节会调用真实模型并产生费用**。请先确认计费方式；用最小 prompt，验收后及时停止流。
建议**不要**设 `OS_GATEWAY_AUTO_APPROVE=1`（否则审批被自动放行，无法验证四按钮）。

**前置**：gateway 可用（真实 `hermes` CLI）；`curl -s $BASE/api/hermes/gateway | jq`。

### 6.1 一次真实生成

**前置**：gateway 可用（§6 开头）。

**步骤**：用 §5.2 的 outline 面板填必填字段 → 选模板 → 点动作；或直接

```bash
curl -N -X POST "$BASE/api/hermes/chat/stream" \
  -H 'content-type: application/json' \
  -d '{"chatId":"acc-1","prompt":"用一句话介绍 24H-OS。","model":"kimi-k2.5"}'
```

**期望**：SSE 依次出现 `session` → `delta`（渐进文本）→ `done`；`curl -s $BASE/api/hermes/gateway | jq '.via'` 显示实际通道（`gateway`/`oneshot`）。断开后 `POST /api/hermes/chat/decide` 之外无残留。

**失败时收集什么**：SSE 原始帧、server 日志、`hermes --version`、模型名与 provider。

### 6.2 审批 `approval` 四按钮语义

**前置**：§6.1 的会话正在流式中，且模型触发了需授权的工具（SSE `type:"approval"`），`payload.choices` 含 `once|session|always|deny`、`requestId`、`chatId`。

**步骤**：在 UI 决策卡片上逐个验证，或直接调用：

```bash
curl -s -X POST "$BASE/api/hermes/chat/decide" -H 'content-type: application/json' \
  -d '{"chatId":"acc-1","type":"approval","choice":"once"}' | jq
```

**期望**
- `once`：仅本次放行，后续同类命令会再次询问；
- `session`：本会话内同类命令不再询问；
- `always`：写入长期许可（注意 ⚠️ 影响后续会话）；
- `deny`：拒绝，模型收到拒绝结果并继续/结束；
- 每个返回 `{"ok":true,"chatId":...,"type":"approval","decision":{...}}`；
- 缺 `chatId`/`type` → 400；对已解决的请求再 decide → 409 `DECISION_RESOLVED`；
- 超时（默认 120s）或流结束 → 自动 deny（SSE `decision.fallback`），**不挂死**。

**失败时收集什么**：SSE 中 `approval` 帧、decide 响应、UI 决策卡片截图、server 日志。

### 6.3 澄清 `clarify` 与中断

**前置**：§6.1 会话中出现 `type:"clarify"`，或需验证中断。

**步骤**

```bash
# 澄清：SSE type:"clarify" 时回答
curl -s -X POST "$BASE/api/hermes/chat/decide" -H 'content-type: application/json' \
  -d '{"chatId":"acc-1","type":"clarify","answer":"用中文"}' | jq
```

**期望**：`clarify` 返回后流继续；中途关闭 SSE 客户端 → 服务端触发 `session.interrupt`，无残留会话。

**失败时收集什么**：SSE 帧、decide 响应、`curl -s $BASE/api/hermes/gateway`、server 日志。

---

## §7 官方 Cron（`cron.manage` 薄封装）

**前置**：真实 `hermes` CLI；工作台首次访问 cron/chat 会**惰性拉起共享 gateway**（带 `HERMES_DESKTOP=1` 触发官方 ticker，除非 `OS_CRON_TICKER=0`）。

### 7.1 列表对照 CLI

**前置**：真实 `hermes` CLI 可用（§7 开头）。

**步骤**

```bash
curl -s "$BASE/api/cron/jobs?include_disabled=true" | jq '{count,jobs:[.jobs[]|{name,schedule,enabled,next_run_at,last_run_at,last_status}],ticker,warning}'
hermes cron list 2>/dev/null || hermes cron --help
```

**期望**：API 的 `jobs` 与 `hermes cron list` 名称/计划一致；`ticker.enabled=true`、`ticker.gatewayRunning=true`（gateway 已起）；无误导性 `warning`。

**失败时收集什么**：两条命令输出、`curl -s $BASE/api/hermes/gateway`、server 日志。

### 7.2 新建 / 暂停 / 恢复 / 删除 / 立即运行

**前置**：§7.1 通过，`ticker.gatewayRunning=true`。

**步骤**

```bash
# 新建（须 confirm）
curl -s -X POST "$BASE/api/cron/jobs" -H 'content-type: application/json' \
  -d '{"confirm":true,"name":"acc-heartbeat","schedule":"2m","prompt":"输出一句话：24H-OS 验收心跳。","deliver":"local"}' | jq

# 缺 confirm → 400 CONFIRM_REQUIRED
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/api/cron/jobs" \
  -H 'content-type: application/json' -d '{"name":"x","schedule":"2m","prompt":"y"}'

for act in pause resume run; do
  curl -s -X POST "$BASE/api/cron/jobs/acc-heartbeat/$act" -H 'content-type: application/json' -d '{"confirm":true}' | jq -c
done

# 对照 CLI
hermes cron list

# 删除（须 confirm）
curl -s -X POST "$BASE/api/cron/jobs/acc-heartbeat/remove" -H 'content-type: application/json' -d '{"confirm":true}' | jq
```

**期望**
- 新建 → `{"ok":true,"action":"add","jobId":...,"name":"acc-heartbeat",...}`，且 **`hermes cron list` 立即出现该任务**；
- 所有写操作缺 `confirm` → 400 `CONFIRM_REQUIRED`（不落盘）；非法 `name`（不匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`）→ 400；
- `pause` → 任务 `enabled:false`；`resume` → `enabled:true`；`run` → 立即执行一次；
- `remove` → CLI 列表消失。

> 官方 schedule 语义：`2m` / `every 2h` / `every monday 9am` / `0 9 * * *` / ISO。`deliver` 支持
> `origin|local|telegram|discord|signal|platform:chat_id|bot-chat[:profile]`。

**失败时收集什么**：各 POST 响应、`hermes cron list` 输出、非法 name 的 400 响应体、server 日志。

### 7.3 触发验证（确认 ticker 真在跑）

**前置**：`ticker.enabled=true` 且 `ticker.gatewayRunning=true`；计划留出 2~3 分钟等待。

**步骤**：建一个 2 分钟后的 `--deliver local` 任务，等 2~3 分钟。

```bash
curl -s -X POST "$BASE/api/cron/jobs" -H 'content-type: application/json' \
  -d '{"confirm":true,"name":"acc-fire","schedule":"2m","prompt":"只回复：fire。","deliver":"local"}' | jq
sleep 150
curl -s "$BASE/api/cron/jobs" | jq '.jobs[]|select(.name=="acc-fire")|{last_run_at,last_status,next_run_at,last_delivery_error}'
ls -la "$HERMES_HOME/cron/output/acc-fire/" 2>/dev/null || echo "（官方输出目录，视 Hermes 版本可能不同）"
```

**期望**
- `last_run_at` 在等待后**变为非空且晚于创建时间**；`last_status` 为成功态（如 `ok`/`success`）；
- `$HERMES_HOME/cron/output/<id>/`（若该版本使用该路径）出现任务输出文件，**非空**；
- 若非空 → 证明 `HERMES_DESKTOP=1` 注入生效、官方 ticker 正常。

**失败排查清单**
1. `OS_CRON_TICKER=0` 被设置 → ticker 被显式关闭；
2. gateway 未起（`ticker.gatewayRunning=false`）→ 访问一次 UI 或 `POST /api/hermes/gateway/start`；
3. 任务 `deliver:"local"` 在无头环境更稳（telegram/discord 无 token 会记 `last_delivery_error`，但任务本身仍执行）；
4. 时区/`next_run_at` 与本地时间不一致；
5. 真实环境 `hermes serve` 版本不带 ticker → 核对官方版本。

**失败时收集什么**：`GET /api/cron/jobs` 完整 JSON、`hermes cron list` 输出、`$HERMES_HOME/cron/`（脱敏）内容、server 启动日志中 gateway 相关行。

**清理**：`POST /api/cron/jobs/acc-fire/remove {"confirm":true}`。

---

## §8 Subagent 观测

**前置**：真实 gateway 会话；子代理**无 spawn RPC**，由模型在会话内用 `delegate_task` 工具创建。

**步骤**
1. 在会话里给模型一个明确需要委派的提示词，例如：
   > 请用 `delegate_task` 派一个子代理调研「Hermes profile 与 skill 的关系」，然后汇总子代理结果给我。
2. 观察 UI 出现的 `subagent.*` 事件（phase 见下）；
3. 记录会话 id（SSE `session` 事件里的 `sessionId`/`chatId`），查询：

```bash
export SID="<会话 id>"
curl -s "$BASE/api/hermes/subagents?sessionId=$SID" | jq '{count,support,subagents:[.subagents[]|{subagent_id,status,last_tool,tool_count,accepting_steer}]}'

# 读取转录（只读）
curl -s "$BASE/api/hermes/subagents/<subagent_id>/tail?sessionId=$SID" | jq '{available,truncated,len:(.text|length)}'

# steering（非破坏，无需 confirm）
curl -s -X POST "$BASE/api/hermes/subagents/<subagent_id>/steer" -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"text\":\"请优先给结论\"}" | jq

# 硬中断（须 confirm）
curl -s -X POST "$BASE/api/hermes/subagents/<subagent_id>/interrupt" -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\",\"confirm\":true}" | jq

# 全局暂停 spawn（须 confirm）
curl -s -X POST "$BASE/api/hermes/subagents/pause" -H 'content-type: application/json' -d '{"paused":true,"confirm":true}' | jq
```

**期望**
- `GET /api/hermes/subagents` → `support.spawnApi=false`、`controlApi=true`、`events=true`、`mechanism="delegate_task (in-session tool)"`；有活跃子代理时 `count>0`；
- SSE 透出 `type:"subagent"`，phase 取 `spawn_requested/start/progress/thinking/tool/complete`（未知 → `unknown`）；
- `tail` 返回 `available` + `text`（截断 16KB）；
- `steer` → `{ok:true,status:"queued"|"rejected"}`；`interrupt` → `{ok,found,...}`；缺 confirm → 400；
- 旧端点 `POST /api/hermes/subagent` → **501** `SPAWN_UNSUPPORTED`（不造假）。

**失败时收集什么**：SSE 原始帧、`GET /api/hermes/subagents?sessionId=...` 响应、模型使用的提示词、`hermes --version`。

---

## §9 Electron 真机（有显示器）

**前置**：`npm run build`，`dist/web` 存在。

### 9.1 启动与加载

**前置**：有显示器；`dist/web` 已构建。

**步骤**

```bash
npm run electron           # 复用/拉起 server，加载 http://127.0.0.1:4319
# 或安装包：
npm run dist
./release/*.AppImage
sudo dpkg -i release/*.deb && 24h-os   # 包名以实际为准
```

**期望**
- 窗口打开并加载 UI（标题 `24H-OS · Hermes 多 agent 工作台`）；
- server 仅监听 `127.0.0.1`（`lsof -i :4319` / `ss -ltnp`）；
- 关闭窗口后：**无残留 `hermes serve` / `server.cjs` / `tsx` 进程**，端口释放。

```bash
# 关闭窗口后再执行：
ss -ltnp | grep 4319 || echo "端口已释放"
ps -ef | grep -E '[s]erver\.cjs|[h]ermes serve|[e]lectron' || echo "无残留进程"
```

**失败时收集什么**：窗口/终端截图、关闭前后 `ps -ef` 与 `ss -ltnp`、Electron 主进程日志。

### 9.2 打包态内容非空

**前置**：已执行 `npm run dist` 且启动过打包版（或至少产出 `release/linux-unpacked/`）。

**步骤**

```bash
# 打包版 server 在 resources/app.asar.unpacked/dist/
ls release/linux-unpacked/resources/app.asar.unpacked/dist/server.cjs
ls release/linux-unpacked/resources/app.asar.unpacked/dist/web/index.html
ls release/linux-unpacked/resources/app.asar.unpacked/market/index.json
ls release/linux-unpacked/resources/app.asar.unpacked/examples/skills/{ppt,outline}/ui
# 启动打包版后：
curl -s http://127.0.0.1:4319/api/market | jq '.entries|length'      # 期望 5
curl -s http://127.0.0.1:4319/api/skill-uis | jq '[.[].id]'          # 期望含 ppt/outline
```

**期望**：上述文件均存在；`/api/market` = 5 条（含 `ppt-maker`）；`/api/skill-uis` 含 `ppt`+`outline`。
无显示器环境（NAS）只能验 headless 首启：日志打印 `headless 环境无法创建窗口…` 并以 **退出码 0** 结束、无残留。

**失败时收集什么**：窗口/终端截图、`ps -ef`、`ss -ltnp`、Electron 主进程日志、`release/linux-unpacked/` 目录树。

---

## §10 写入四重保证

**前置**：`AGENT` 为测试 profile。

### 10.1 无 confirm → 400 且无落盘

**前置**：`AGENT` 为测试 profile；已记录当前文件清单。

**步骤**

```bash
BEFORE=$(find "$HERMES_HOME" "$META_DIR" "$BACKUP_DIR" -type f 2>/dev/null | sort | sha256sum)
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$BASE/api/agents/$AGENT/config" \
  -H 'content-type: application/json' -d '{"model":"acc-should-not-write"}'
AFTER=$(find "$HERMES_HOME" "$META_DIR" "$BACKUP_DIR" -type f 2>/dev/null | sort | sha256sum)
[ "$BEFORE" = "$AFTER" ] && echo "未落盘 ✅" || echo "⚠️ 磁盘发生变化"
```

**期望**：HTTP **400**，body `CONFIRM_REQUIRED`；前后文件清单哈希一致（未新增/修改文件）。

**失败时收集什么**：HTTP 状态码、响应体、两次文件清单（`find ... -print`）、server 日志。

### 10.2 备份存在且 ≤10 份

**前置**：`SOUL.md` / `config.yaml` 等目标文件已存在（首次创建不产生备份）。

**步骤**

```bash
# 触发任意文件回退写（例如重复 PATCH SOUL），然后：
ls -1t "$BACKUP_DIR/$AGENT" | head -20
ls -1 "$BACKUP_DIR/$AGENT" | wc -l      # 每个文件最多 10 份
```

**期望**：出现 `<文件名>.<ISO 时间戳>.bak`；同一 base 文件的 `.bak` 数量 **≤10**（超出会删最旧）。

**失败时收集什么**：`ls -la "$BACKUP_DIR/$AGENT"`、对应 PATCH 响应中 `backups[]`、server 日志。

### 10.3 无 `.tmp*` 残留

**前置**：刚执行过任意写操作。

**步骤**

原子写临时文件命名：`<file>.tmp-<pid>-<ts>-<rand>`。

```bash
find "$HERMES_HOME" "$META_DIR" -name '*.tmp*' -print 2>/dev/null || true
```

**期望**：**无输出**（写入成功即 `rename`，中断会清理临时文件）。

**失败时收集什么**：`find` 输出、该文件所在目录 `ls -la`、server 日志。

### 10.4 密钥不回显

**前置**：`AGENT` 为测试 profile（会临时写入一个密钥，§末尾清理）。

**步骤**

```bash
# 设置一个密钥（响应不得含明文）
curl -s -X POST "$BASE/api/agents/$AGENT/env" -H 'content-type: application/json' \
  -d '{"key":"ACC_TEST_SECRET","value":"super-secret-value","confirm":true}' | jq
# 全局扫描响应中是否有明文
curl -s "$BASE/api/agents/$AGENT/config" | grep -c "super-secret-value" || echo "0（未回显 ✅）"
grep -R "super-secret-value" "$META_DIR" "$HOME/.24os/apps" 2>/dev/null || echo "元数据内无明文 ✅"
```

**期望**
- `POST /env` 返回 `{"ok":true,"action":"set-env","via":"cli"|"file",...}`，`message` 含键名、**不含** `super-secret-value`；
- `GET /config` 的 `envKeys` 含 `ACC_TEST_SECRET`，但响应体 **grep 不到明文值**；
- 若走 `.env` 回退（`via:"file"`），明文只存在于 `$PROFILE_DIR/.env`（文件权限由系统管理），**不出现在任何 API 响应或日志**；
- `~/.24os/agents`、`~/.24os/apps` 内无明文。

**清理**：`curl -s -X DELETE "$BASE/api/agents/$AGENT/env/ACC_TEST_SECRET" -H 'content-type: application/json' -d '{"confirm":true}' | jq`。

**失败时收集什么**：各响应、`grep` 结果、`.env` 的**键名**（绝不要贴明文值）、server 日志脱敏片段。

---

## §11 清理与恢复

**前置**：已完成测试项；§0 的 `DEST` 备份仍可用。

**步骤**

```bash
# 1) 卸载测试 App（会保留备份）
curl -s -X POST "$BASE/api/market/ppt-maker/apply" -H 'content-type: application/json' -d '{"mode":"uninstall","confirm":true}' | jq '.message'
# 2) 删除测试 profile / 元数据 / App 记录
rm -rf "$HERMES_HOME/profiles/acc-test" "$META_DIR/acc-test" "$HOME/.24os/apps/acc-test.json"
# 3) 停进程、清端口
pkill -f 'server/index.ts'; pkill -f 'dist/server.cjs'   # 或 Ctrl-C 各终端
ss -ltnp | grep 4319 || echo "端口 4319 已释放"

# 4) 查看本次改动（对照 §0 基线）
find "$HERMES_HOME" "$META_DIR" "$BACKUP_DIR" -type f -newer "$DEST/marker" -print 2>/dev/null

# 5) 从备份恢复（危险：先确认 DEST 正确）
tar tzf "$DEST/hermes.tar.gz" | head
# 例：恢复到临时目录做比对，确认无误后再覆盖
mkdir -p /tmp/24os-restore && tar xzf "$DEST/hermes.tar.gz" -C /tmp/24os-restore
# 确认后（⚠️ 覆盖前务必再次确认）：
# rm -rf "$HOME/.hermes" && tar xzf "$DEST/hermes.tar.gz" -C "$HOME"
```

**期望**
- 测试 profile / 记录 / 进程 / 端口全部清理；
- 基线对比只列出**你明知**改过的文件；
- 恢复命令 `tar tzf` 能列出归档内容，`sha256sum -c` 仍 `OK`。

**失败时收集什么**：`ps -ef`、`ss -ltnp`、`find -newer` 结果、`tar tzf` 报错。

---

## §12 反馈模板

每一项失败请附上下列证据（**脱敏后再提交，切勿粘贴密钥明文 / auth.json**）：

1. **环境**：`node -v`、`hermes --version`、OS 版本、启动方式（dev/生产/Electron/安装包）。
2. **复现**：粘贴本清单对应编号的**完整命令**与**原始输出**（stdout+stderr）。
3. **期望 vs 实际**：一句话说明与本清单哪条期望不符。
4. **浏览器侧**：Console error 截图/文本；Network 中失败请求的 URL + 状态码 + 响应体。
5. **服务端**：server 终端完整日志（从启动到报错）。
6. **单测基线**：`npm run check` 输出（确认 533 通过）。
7. **相关文件**（脱敏）：`$PROFILE_DIR/config.yaml`、`$META_DIR/$AGENT/meta.json`、`~/.24os/apps/<id>.json`、`$BACKUP_DIR/<id>/` 列表；`config.yaml` 中如含密钥行请替换为 `***`。
8. **冒烟脚本**：`node scripts/acceptance-smoke.mjs` 的完整输出（含退出码）。

一条可复制的信息收集命令（生成一个脱敏证据包）：

```bash
STAMP=$(date +%Y%m%d-%H%M%S); OUT="/tmp/24os-feedback-$STAMP"; mkdir -p "$OUT"
{
  echo "== node =="; node -v 2>&1
  echo "== hermes =="; hermes --version 2>&1
  echo "== check =="; npm run check 2>&1 | tail -20
  echo "== smoke =="; node scripts/acceptance-smoke.mjs 2>&1; echo "smoke exit=$?"
  echo "== agents =="; curl -s "$BASE/api/agents" 2>&1
  echo "== status =="; curl -s "$BASE/api/hermes/status" 2>&1
} > "$OUT/report.txt" 2>&1
# 附带脱敏文件清单（不含内容）
find "$PROFILE_DIR" "$META_DIR/$AGENT" "$HOME/.24os/apps" -maxdepth 2 -type f 2>/dev/null > "$OUT/files.txt"
tar czf "/tmp/24os-feedback-$STAMP.tar.gz" -C /tmp "24os-feedback-$STAMP"
echo "证据包：/tmp/24os-feedback-$STAMP.tar.gz（提交前请自行检查并脱敏）"
```

> ⚠️ 提交前务必检查证据包：**删除** `auth.json`、`.env` 明文、任何 API key/token。命令行里也不要 `cat` 密钥文件。
