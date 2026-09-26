# 官方 Cron 薄封装（M8）

> 24H-OS 的「定时」**完全交给 Hermes 官方 Cron**。工作台不再自带调度器
> （原 `~/.24os/bots.yaml` + 30s tick 已删除），只做三件事：
> 1. 把官方 `cron.manage` RPC 封装成 REST；2. 订阅官方 `cron.changed` 事件；
> 3. 让 `hermes serve` 带 `HERMES_DESKTOP=1`，触发官方内置 ticker。

内核版本：**Hermes v0.21.3**。

## 1. 官方契约（只读调研）

| 项 | 结论 |
| --- | --- |
| RPC | `cron.manage`，params `{action: list\|add\|remove\|pause\|resume, name, include_disabled, schedule, prompt, repeat, continuity, deliver, profile}` |
| handler | `tui_gateway/methods_tools.py::_scoped_rpc("cron.manage", 5023)` → `tools.cronjob_tools.cronjob` |
| 结果 | `CronManageResult`（`jobs`/`count`/`scoped`、`job_id`/`job`、`removed_job`、`warning`、`error`），见 `tui_gateway/contracts/tools_commands.py` |
| 事件 | `cron.changed`（监听 `cron/jobs.json` mtime）；帧为 `{method:"event", params:{type:"cron.changed", ...}}` |
| CLI | `hermes cron list\|create\|pause\|resume\|run\|rm\|status\|runs\|doctor\|tick` |
| 存储 | `$HERMES_HOME/cron/jobs.json`；per-profile：`$HERMES_HOME/profiles/<name>/cron/jobs.json` |
| 输出 | `$HERMES_HOME/cron/output/<job_id>/<ts>.md` |
| 调度语义 | `30m` / `every 30m` / `in 30m` / `every monday 9am` / `0 9 * * *` / ISO；时区 `HERMES_TIMEZONE` → `config.yaml:timezone` → 本地 |
| `deliver` | `origin\|local\|telegram\|discord\|signal\|platform:chat_id\|bot-chat[:profile]` |

> RPC 实测**不需要额外 capability**：连接后仅需 SESSION_TOKEN，`cron.manage` 的
> list/add/pause/resume/remove 全部成功（scope 5023 由服务端处理）。

## 2. 触发机制实证（隔离 `HERMES_HOME`）

实验用 `--no-agent --script` 的脚本 job（**不调用真实模型**），schedule `* * * * *`：

| 方式 | 是否触发 | 证据 |
| --- | --- | --- |
| `hermes serve`（**不带** `HERMES_DESKTOP`） | ❌ | `last_run_at: null`，无输出文件/Marker |
| `hermes serve`（**带** `HERMES_DESKTOP=1`） | ✅ ~4s | `PROBE_RAN` + `last_run_at` 更新 + `cron/output/<id>/…md` |
| `hermes gateway run`（无平台 token） | ✅ ~72s | 启动仅告警 `No messaging platforms enabled.`，进程不退出并触发 |
| `hermes cron tick`（手动一次性） | ✅ | 到点后执行一次（`exit 0`） |

### 选型：首选 `HERMES_DESKTOP=1` 的 `hermes serve`

- 工作台本就在 `ensureGateway` 里 spawn `hermes serve`，只需注入 env，
  **不引入新进程 / 不自研循环**；
- 走官方 ticker + 官方 `cron/.tick.lock`，与官方 desktop dashboard 同源；
- `hermes gateway run` 虽也能触发，但会初始化消息平台子系统并产生非致命
  warm-up traceback（本机 venv `SystemError: AST …`），且需额外管理长驻进程；
- `hermes cron tick` 仅作**手动兜底**（`POST /api/cron/jobs/:name/run`），
  **不**做每 60s 循环（那等于自研调度器）。

实现：`server/hermes/gateway.ts#resolveGatewayEnv()` 默认注入 `HERMES_DESKTOP=1`；
`OS_CRON_TICKER=0` 关闭。

## 3. REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/cron/jobs?include_disabled=1&profile=<name>` | 官方 jobs 列表 + ticker 状态 |
| POST | `/api/cron/jobs` | 新增（**须 `confirm:true`**） |
| POST | `/api/cron/jobs/:name/pause` | 暂停（须 `confirm:true`） |
| POST | `/api/cron/jobs/:name/resume` | 恢复（须 `confirm:true`） |
| POST | `/api/cron/jobs/:name/remove` | 删除（须 `confirm:true`） |
| POST | `/api/cron/jobs/:name/run` | 立即运行一次（须 `confirm:true`，CLI 兜底） |

- **写操作四重保证**：`confirm` 门禁 → 备份到 `~/.24os/backups/cron/`（每文件最多 10 份）
  → 原子性由官方 RPC/CLI 负责 → 响应只回摘要、不回显提示词全文。
- 非法 `name`（非 `^[a-z0-9][a-z0-9_-]{0,63}$`）→ 400 `INVALID_NAME`，不触发 RPC。
- 任务不存在 → 404 `CRON_JOB_NOT_FOUND`；RPC 异常 → 502 `CRON_RPC_ERROR`；
  gateway 不可用 → 503 `CRON_UNAVAILABLE`。

## 4. 从 `bots.yaml` 迁移

| 旧（已删除） | 新（官方 cron） |
| --- | --- |
| `~/.24os/bots.yaml` 的 `bots[]` | 每条 → 一次 `cron.manage{action:"add"}` |
| `id` | `name`（`^[a-z0-9][a-z0-9_-]{0,63}$`） |
| `schedule: "HH:MM"` | `CronJob` 的 `name`；schedule 用 `0 9 * * *` 等官方语义 |
| `profile` | `profile`（per-profile store） |
| `prompt` | `prompt` |
| `notify: [plugin]` | `deliver`（`origin`/`local`/平台通道） |
| `enabled:false` | 创建后 `pause`（或 `--paused`） |
| API `/api/bots` | `/api/cron/jobs`（**无兼容别名**） |
| 调度器 30s tick | 官方 ticker（`HERMES_DESKTOP=1` 的 `hermes serve`） |

迁移示例：

```bash
# 旧：~/.24os/bots.yaml
#   id: daily-report
#   schedule: "09:00"
#   profile: default
#   prompt: "生成简报"
export HERMES_HOME=/path/to/hermes-home
hermes cron create "0 9 * * *" "生成简报" --name daily-report --deliver local
```

## 5. 环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `OS_CRON_TICKER` | `0` 关闭「serve 带 `HERMES_DESKTOP=1` 触发官方 ticker」 | 开 |
| `OS_CRON_CACHE_TTL_MS` | jobs 列表缓存 TTL | `2000` |
| `OS_BACKUP_DIR` | cron 写前备份根（`<dir>/cron/`） | `~/.24os/backups` |

## 6. 风险 / 已知限制

- **`deliver` 平台通道**：无头环境未配 token（telegram/discord/…）时，官方投递会记录
  `last_delivery_error`，但**任务本身仍会执行**；无头建议 `deliver:"local"`。
- **触发依赖 gateway**：官方 ticker 只在 gateway 进程（`hermes serve` / messaging gateway）里跑。
  工作台在首次访问 cron API / chat 时惰性拉起共享 gateway；若从不访问，任务不会自动触发
  （列表里仍可见，手动 `run` 可用）。
- **官方 warning 会误判**：`cron.manage` 的 `warning`（"gateway is not running"）按 messaging
  gateway 的 runtime lock/PID 判断，**看不到** desktop serve 的 ticker。当工作台的共享 gateway
  （`HERMES_DESKTOP=1` 的 `hermes serve`）在跑时，REST 层会抑制这条误导性 warning
  （`server/routes/cron.ts#isTickerActive`）。
- `run-now` 走 CLI `hermes cron run`（`stdio[0]="ignore"` + 超时，等效 `</dev/null`），
  官方 RPC 暂无 `run` 动作。
